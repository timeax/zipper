// src/remote-sftp.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import * as unzipper from "unzipper";
import SftpClient from "ssh2-sftp-client";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as tar from "tar";

import type { RemoteSftpOpts } from "./types"; // <- from your types.ts

/* ------------------------------------------------------------------ */
/* Public API: Upload (SFTP)                                           */
/* ------------------------------------------------------------------ */

export async function uploadViaSFTP(opts: RemoteSftpOpts) {
  const start = Date.now();
  const {
    host,
    user,
    password,
    webroot,
    domain,                  // <-- may be used to derive webroot
    zipPath,
    preservePaths = ["uploads/", "storage/", ".well-known/", "robots.txt"],
    port = 22,
    dryRun = false,
    timeoutMs = 0,
    concurrency = 4,
    confirm = "auto",
    yes = false,
  } = opts;

  // Derive webroot from domain when not provided
  const resolvedWebroot = webroot ?? (domain ? deriveDefaultWebroot(user, domain) : undefined);
  if (!resolvedWebroot) {
    throw new Error("Missing webroot. Provide --webroot or --domain (to derive /home/<user>/web/<domain>/public_html).");
  }

  const zipAbs = path.isAbsolute(zipPath) ? zipPath : path.resolve(process.cwd(), zipPath);
  if (!fs.existsSync(zipAbs)) throw new Error(`ZIP not found: ${zipAbs}`);

  // 1) Unzip locally to temp dir and enumerate files
  const tmpRoot = await unzipToTemp(zipAbs);
  const localFiles = await listLocalFiles(tmpRoot); // posix rel paths

  const normal = (p: string) => p.replaceAll("\\", "/").replace(/^\.?\//, "");
  const preserves = (preservePaths ?? []).map(normal);
  const isPreservedRel = (rel: string) => preserves.some(p => preserveMatch(rel, p));

  // Preview + confirm
  await maybeConfirm({
    server: `${user}@${host}:${port}`,
    webroot: resolvedWebroot,
    zip: zipAbs,
    releaseDir: tmpRoot,
    localCount: localFiles.length,
    preserved: preserves,
    dryRun, domain: domain ?? "null"
  }, confirm, yes);

  // 2) Connect SFTP
  const sftp = new SftpClient();
  await sftp.connect({
    host,
    port,
    username: user,
    password,
    readyTimeout: timeoutMs && timeoutMs > 0 ? timeoutMs : 20000,
  });

  // Ensure webroot exists
  await ensureDirAbs(sftp, resolvedWebroot);

  // 3) Build remote tree (relative to resolvedWebroot)
  const remoteTree = await listRemoteTree(sftp, resolvedWebroot);
  const remoteFilesSet = new Set(remoteTree.files.map(f => f.rel)); // rel to resolvedWebroot

  // Split locals by preserved
  const localNonPreserve = localFiles.filter(f => !isPreservedRel(f));
  const localPreserve = localFiles.filter(f => isPreservedRel(f));

  // 4) Phase A — delete files not present in local (outside preserved), then upload non-preserved
  const localNonPreserveSet = new Set(localNonPreserve);
  const remoteNonPreserve = remoteTree.files.filter(f => !isPreservedRel(f.rel));

  const toDelete = remoteNonPreserve
    .filter(x => !localNonPreserveSet.has(x.rel))
    .map(x => x.rel);

  if (toDelete.length) {
    console.log(pc.dim(`Phase A: deleting ${toDelete.length} remote file(s) (outside preserved)`));
  }
  for (const rel of toDelete) {
    if (dryRun) { console.log(pc.dim(`  - rm ${rel}`)); continue; }
    await safeRemoveFile(sftp, joinRemote(resolvedWebroot, rel));
  }

  if (localNonPreserve.length) {
    console.log(pc.dim(`Phase A: uploading ${localNonPreserve.length} file(s) (outside preserved)`));
    await uploadManySftp(sftp, tmpRoot, resolvedWebroot, localNonPreserve, { concurrency, dryRun });
  }

  // 5) Phase B — merge into preserved: upload files that do NOT exist remotely
  if (localPreserve.length) {
    const newPreserve = localPreserve.filter(rel => !remoteFilesSet.has(rel));
    console.log(pc.dim(`Phase B: merging ${newPreserve.length}/${localPreserve.length} file(s) into preserved paths`));
    await uploadManySftp(sftp, tmpRoot, resolvedWebroot, newPreserve, { concurrency, dryRun });
  }

  // 6) Try to prune empty remote directories (outside preserved)
  const remoteDirsDesc = remoteTree.dirs
    .map(d => d.rel)
    .filter(rel => !isPreservedRel(rel + "/"))
    .sort((a, b) => b.length - a.length);

  let pruned = 0;
  for (const rel of remoteDirsDesc) {
    if (dryRun) continue;
    try {
      await sftp.rmdir(joinRemote(resolvedWebroot, rel));
      pruned++;
    } catch { /* ignore if not empty or perms */ }
  }
  if (pruned) console.log(pc.dim(`Pruned ${pruned} empty remote director${pruned === 1 ? "y" : "ies"}.`));

  await sftp.end();

  // 7) Cleanup temp release
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }

  const ms = Date.now() - start;
  console.log(pc.green(`✔ SFTP deploy done in ${Math.round(ms / 1000)}s`));
}

/* ------------------------------------------------------------------ */
/* Public API: Restore (SFTP)                                          */
/* - Reuses RemoteSftpOpts for connection & behavior                   */
/* - Restore-specific selectors are passed via the CLI wrapper only    */
/* ------------------------------------------------------------------ */

type RestoreSelectors = {
  /** Use a local backup archive (.zip | .tar.gz | .tgz). If omitted, pull from remote. */
  localBackupPath?: string;
  /** Remote backup directory (when pulling from server) */
  remoteBackupDir?: string;
  /** Filter candidates by prefix (e.g. example.com-public_html-) */
  remoteBackupPrefix?: string;
  /** Exact file name to restore from (in remoteBackupDir). If omitted, pick latest by name. */
  remoteBackupName?: string;
};

export async function restoreViaSFTP(conn: RemoteSftpOpts, sel: RestoreSelectors) {
  const {
    host, user, password, port = 22,
    webroot,
    domain, // <-- may be used to derive webroot & default backup prefix
    preservePaths = ["uploads/", "storage/", ".well-known/", "robots.txt"],
    dryRun = false, timeoutMs = 0, concurrency = 4, confirm = "auto", yes = false,
  } = conn;

  const { localBackupPath, remoteBackupDir } = sel;
  let { remoteBackupPrefix, remoteBackupName } = sel;

  // Derive webroot from domain when not provided
  const resolvedWebroot = webroot ?? (domain ? deriveDefaultWebroot(user, domain) : undefined);
  if (!resolvedWebroot) {
    throw new Error("Missing webroot. Provide --webroot or --domain (to derive /home/<user>/web/<domain>/public_html).");
  }

  // Default backup prefix from domain if not supplied
  if (!remoteBackupPrefix && domain) {
    remoteBackupPrefix = `${domain}-public_html`;
  }

  if (!localBackupPath && !remoteBackupDir) {
    throw new Error("Provide either localBackupPath or remoteBackupDir (+ optional prefix/name).");
  }

  const sftp = new SftpClient();
  await sftp.connect({
    host,
    port,
    username: user,
    password,
    readyTimeout: timeoutMs && timeoutMs > 0 ? timeoutMs : 20000,
  });

  let archivePath: string;
  if (localBackupPath) {
    archivePath = path.isAbsolute(localBackupPath) ? localBackupPath : path.resolve(process.cwd(), localBackupPath);
    if (!fs.existsSync(archivePath)) {
      await sftp.end();
      throw new Error(`Local backup not found: ${archivePath}`);
    }
  } else {
    // list remote backups and pick desired one
    const list = await sftp.list(remoteBackupDir!);
    const candidates = list
      .filter(x => x.type !== "d")
      .map(x => x.name)
      .filter(n => n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".zip"))
      .filter(n => remoteBackupPrefix ? n.startsWith(`${remoteBackupPrefix}`) : true)
      .sort((a, b) => b.localeCompare(a)); // crude "latest" by name

    const chosen = remoteBackupName || candidates[0];
    if (!chosen) {
      await sftp.end();
      throw new Error(`No matching backups in ${remoteBackupDir}`);
    }
    const remoteFile = path.posix.join(remoteBackupDir!, chosen);

    // download to temp
    const tmpFile = path.join(os.tmpdir(), `zipper-sftp-rest-${Date.now()}-${chosen}`);
    await sftp.fastGet(remoteFile, tmpFile);
    archivePath = tmpFile;
  }

  // extract locally and compute list
  const tmpRoot = await extractToTemp(archivePath);
  const localRoot = await inferDocumentRoot(tmpRoot);
  const localFiles = await listLocalFiles(localRoot);

  // confirm
  const preserves = (preservePaths ?? []).map(p => p.replaceAll("\\", "/").replace(/^\.?\//, ""));
  await maybeConfirm({
    server: `${user}@${host}:${port}`, webroot: resolvedWebroot, zip: archivePath,
    releaseDir: localRoot, localCount: localFiles.length, preserved: preserves, dryRun, domain: domain ?? "null"
  }, confirm, yes);

  // ensure webroot
  await ensureDirAbs(sftp, resolvedWebroot);

  // list remote (relative to resolvedWebroot)
  const remoteTree = await listRemoteTree(sftp, resolvedWebroot);
  const remoteFilesSet = new Set(remoteTree.files.map(f => f.rel));

  const isPreserved = (rel: string) => preserves.some(p => preserveMatch(rel, p));
  const localNonPreserve = localFiles.filter(f => !isPreserved(f));
  const localPreserve = localFiles.filter(f => isPreserved(f));

  // delete outside preserved
  const localNonPreserveSet = new Set(localNonPreserve);
  const remoteNonPreserve = remoteTree.files.filter(f => !isPreserved(f.rel));
  const toDelete = remoteNonPreserve.filter(x => !localNonPreserveSet.has(x.rel)).map(x => x.rel);
  if (toDelete.length) console.log(pc.dim(`Phase A: deleting ${toDelete.length} remote file(s)`));
  for (const rel of toDelete) {
    if (dryRun) { console.log(pc.dim(`  - rm ${rel}`)); continue; }
    await safeRemoveFile(sftp, joinRemote(resolvedWebroot, rel));
  }

  // upload outside preserved
  if (localNonPreserve.length) {
    console.log(pc.dim(`Phase A: uploading ${localNonPreserve.length} file(s)`));
    await uploadManySftp(sftp, localRoot, resolvedWebroot, localNonPreserve, { concurrency, dryRun });
  }

  // merge into preserved
  const newPreserve = localPreserve.filter(rel => !remoteFilesSet.has(rel));
  if (newPreserve.length) {
    console.log(pc.dim(`Phase B: merging ${newPreserve.length}/${localPreserve.length} file(s) into preserved`));
    await uploadManySftp(sftp, localRoot, resolvedWebroot, newPreserve, { concurrency, dryRun });
  }

  await sftp.end();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }

  console.log(pc.green(`✔ SFTP restore complete`));
}

/* ------------------------------------------------------------------ */
/* CLI wrappers                                                        */
/* ------------------------------------------------------------------ */

export async function cliUploadSFTP() {
  const args = parseArgs(process.argv.slice(2));
  const get = (k: string, d?: string) => (k in args ? String(args[k]) : d);
  const req = (k: string) => {
    if (!(k in args)) throw new Error(`Missing --${k}`);
    return String(args[k]);
  };

  const yes = truthy(get("yes")) || truthy(process.env.YES) || truthy(process.env.FORCE);

  await uploadViaSFTP({
    host: req("host"),
    user: req("user"),
    password: get("pass") ?? get("password") ?? process.env.ZIPPER_SFTP_PASS,
    // webroot optional if domain present (function will derive)
    webroot: get("webroot"),
    domain: get("domain"),
    zipPath: req("zip"),
    preservePaths: split(get("preserve")),
    port: get("port") ? Number(get("port")) : 22,
    dryRun: !!args["dry-run"],
    timeoutMs: get("timeout") ? Number(get("timeout")) : 0,
    concurrency: get("concurrency") ? Number(get("concurrency")) : 4,
    confirm: ((): "auto" | "always" | "never" => {
      const c = get("confirm");
      return c === "always" || c === "never" ? c : "auto";
    })(),
    yes,
  });
}

export async function cliRestoreSFTP() {
  const a = parseArgs(process.argv.slice(2)) as Record<string, string | true>;
  const req = (k: string) => {
    if (!(k in a)) throw new Error(`Missing --${k}`);
    return String(a[k]);
  };
  const get = (k: string, d?: string) => (k in a ? String(a[k]) : d);

  const yes = truthy(get("yes")) || truthy(process.env.YES) || truthy(process.env.FORCE);

  // connection/behavior from RemoteSftpOpts
  const conn: RemoteSftpOpts = {
    host: req("host"),
    user: req("user"),
    domain: get("domain"),
    password: get("pass") ?? get("password") ?? process.env.ZIPPER_SFTP_PASS,
    // webroot optional if domain present (function will derive)
    webroot: get("webroot"),
    // zipPath not used for restore; provide a placeholder to satisfy the type
    zipPath: get("zip") ?? "unused.zip",
    preservePaths: split(get("preserve")),
    port: get("port") ? Number(get("port")) : 22,
    dryRun: !!a["dry-run"],
    timeoutMs: get("timeout") ? Number(get("timeout")) : 0,
    concurrency: get("concurrency") ? Number(get("concurrency")) : 4,
    confirm: ((): "auto" | "always" | "never" => {
      const c = get("confirm");
      return c === "always" || c === "never" ? c : "auto";
    })(),
    yes,
  };

  // restore-specific selectors (not part of the interface)
  const sel: RestoreSelectors = {
    localBackupPath: get("backup"),
    remoteBackupDir: get("remote-dir"),
    // if not provided, restoreViaSFTP will default remoteBackupPrefix from domain
    remoteBackupPrefix: get("remote-prefix"),
    remoteBackupName: get("remote-name"),
  };

  await restoreViaSFTP(conn, sel);
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(xs: string[]) {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < xs.length; i++) {
    const t = xs[i];
    if (t.startsWith("--")) {
      const key = t.replace(/^--/, "");
      if (i + 1 < xs.length && !xs[i + 1].startsWith("--")) out[key] = xs[++i];
      else out[key] = true;
    }
  }
  return out;
}

function truthy(v?: string) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}
function split(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function deriveDefaultWebroot(user: string, domain: string) {
  return `/home/${user}/web/${domain}/public_html`;
}

async function unzipToTemp(zipPath: string): Promise<string> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zipper-sftp-"));
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: tmp }))
    .promise();
  return tmp;
}

async function listLocalFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefixRel = ""): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.posix.join(prefixRel.replaceAll("\\", "/"), e.name);
      if (e.isDirectory()) await walk(abs, rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(root, "");
  return out.sort();
}

type RemoteTree = {
  files: { rel: string; size: number }[];
  dirs: { rel: string }[];
};

/** List remote files/dirs under `baseAbs`, returning rel paths (relative to baseAbs). */
async function listRemoteTree(sftp: SftpClient, baseAbs: string): Promise<RemoteTree> {
  const files: RemoteTree["files"] = [];
  const dirs: RemoteTree["dirs"] = [];

  async function walk(absDir: string) {
    let list;
    try { list = await sftp.list(absDir); } catch { return; }
    for (const it of list) {
      const absChild = path.posix.join(absDir, it.name);
      const rel = posixRelative(baseAbs, absChild);
      if (it.type === "d") {
        dirs.push({ rel });
        await walk(absChild);
      } else if (it.type === "-" || it.type === "l") {
        files.push({ rel, size: Number(it.size ?? 0) });
      }
    }
  }

  await walk(baseAbs);
  return { files, dirs };
}

function preserveMatch(rel: string, preserve: string) {
  if (preserve.endsWith("/")) {
    const p = preserve.replace(/\/+$/, "") + "/";
    return rel.startsWith(p);
  }
  return rel === preserve;
}

async function ensureDirAbs(sftp: SftpClient, absPath: string) {
  const segs = absPath.replaceAll("\\", "/").split("/").filter(Boolean);
  let cur = absPath.startsWith("/") ? "/" : "";
  for (const s of segs) {
    cur = path.posix.join(cur || "/", s);
    try { await sftp.mkdir(cur); } catch { /* exists */ }
  }
}

async function safeRemoveFile(sftp: SftpClient, absPath: string) {
  try { await sftp.delete(absPath); }
  catch {
    try { await sftp.rmdir(absPath, true as any); } catch { /* ignore */ }
  }
}

function joinRemote(baseAbs: string, rel: string) {
  return path.posix.join(baseAbs, rel);
}
function posixRelative(fromAbs: string, toAbs: string) {
  const a = fromAbs.replaceAll("\\", "/").replace(/\/+$/g, "");
  const b = toAbs.replaceAll("\\", "/");
  let rel = path.posix.relative(a || "/", b);
  rel = rel.replace(/^\.\/?/, "");
  return rel;
}

async function uploadManySftp(
  sftp: SftpClient,
  localRoot: string,
  webroot: string,
  relFiles: string[],
  opts: { concurrency: number; dryRun: boolean }
) {
  const limit = Math.max(1, Math.min(16, opts.concurrency | 0));
  let active = 0, idx = 0, done = 0;

  return new Promise<void>((resolve, reject) => {
    const next = () => {
      if (idx >= relFiles.length && active === 0) return resolve();
      while (active < limit && idx < relFiles.length) {
        const rel = relFiles[idx++];
        active++;
        (async () => {
          const local = path.join(localRoot, rel.replaceAll("/", path.sep));
          const remote = joinRemote(webroot, rel);
          const remoteDir = path.posix.dirname(remote);
          try {
            if (!opts.dryRun) {
              await ensureDirAbs(sftp, remoteDir);
              await sftp.fastPut(local, remote);
            } else {
              console.log(pc.dim(`  + up ${rel}`));
            }
            done++;
            if (done % 250 === 0) console.log(pc.dim(`  … uploaded ${done}/${relFiles.length}`));
          } catch (e) {
            return reject(e);
          } finally {
            active--;
            next();
          }
        })();
      }
    };
    next();
  });
}

/* extraction helpers for restore */
async function extractToTemp(archive: string) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zipper-rest-sftp-"));
  const lower = archive.toLowerCase();
  if (lower.endsWith(".zip")) {
    await fs.createReadStream(archive).pipe(unzipper.Extract({ path: tmp })).promise();
  } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    await tar.x({ file: archive, cwd: tmp });
  } else {
    throw new Error(`Unsupported backup format: ${archive}`);
  }
  return tmp;
}
async function inferDocumentRoot(tmp: string) {
  const cand = path.join(tmp, "public_html");
  return fs.existsSync(cand) ? cand : tmp;
}

async function maybeConfirm(
  pre: { server: string; webroot: string; zip: string; releaseDir: string; localCount: number; preserved: string[]; dryRun: boolean;  domain: string },
  confirm: "auto" | "always" | "never",
  yes: boolean
) {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (confirm === "never") return;
  if (!interactive && !yes) throw new Error("Non-interactive session. Pass --yes (or YES=1) to proceed.");

  if (interactive && (confirm === "always" || (confirm === "auto" && !yes))) {
    const size = (await fs.promises.stat(pre.zip)).size;
    const human = humanSize(size);
    console.log("");
    console.log("============ DEPLOY PREVIEW (SFTP) ============");
    console.log(` Server         : ${pre.server}`);
    console.log(` Webroot        : ${pre.webroot}`);
    console.log(` Domain         : ${pre.domain}`);
    console.log(` ZIP/ARCHIVE    : ${pre.zip} (${human})`);
    console.log(` Exploded dir   : ${pre.releaseDir}`);
    console.log(` Local files    : ${pre.localCount}`);
    console.log(` Preserve paths :`); for (const p of pre.preserved) console.log(`   • ${p}`);
    console.log(` Delete mode    : Phase A deletes remote files not present (outside preserved)`);
    console.log(` DRY RUN        : ${pre.dryRun ? "1" : "0"}`);
    console.log("===============================================");
    console.log("");
    const rl = createInterface({ input, output });
    try {
      const ans = await rl.question("Proceed? [y/N] ");
      if (!/^(y|yes)$/i.test(ans.trim())) throw new Error("Aborted by user.");
    } finally { rl.close(); }
  }
}

function humanSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}