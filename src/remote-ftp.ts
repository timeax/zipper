// src/remote-ftp.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import * as unzipper from "unzipper";
import { Client, AccessOptions, FileInfo } from "basic-ftp";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as tar from "tar";

import { RemoteFtpOpts, RestoreFtpOpts, FtpSecurity } from "./types";

/* ------------------------------------------------------------------ */
/* Public API: Upload (FTP/FTPS)                                       */
/* ------------------------------------------------------------------ */

export async function uploadViaFTP(opts: RemoteFtpOpts) {
   const start = Date.now();
   const {
      host,
      user,
      password,
      domain,
      webroot,
      preservePaths = ["uploads/", "storage/", ".well-known/", "robots.txt"],
      zipPath,
      secure = "explicit",
      port = secure === "implicit" ? 990 : 21,
      secureOptions,
      dryRun = false,
      timeoutMs = 0,
      concurrency = 4,
      confirm = "auto",
      yes = false,
   } = opts;

   const resolvedWebroot = webroot ?? (domain ? deriveDefaultWebroot(user, domain) : undefined);
   if (!resolvedWebroot) {
      throw new Error("webroot not provided and cannot derive it: set either webroot or domain in your config.");
   }

   const zipAbs = path.isAbsolute(zipPath) ? zipPath : path.resolve(process.cwd(), zipPath);
   if (!fs.existsSync(zipAbs)) throw new Error(`ZIP not found: ${zipAbs}`);

   // 1) Unzip locally to temp dir
   const tmpRoot = await unzipToTemp(zipAbs);
   const localFiles = await listLocalFiles(tmpRoot); // relative POSIX paths

   // Compute preserve filters (normalize with trailing slash semantics)
   const normalize = (p: string) => p.replaceAll("\\", "/").replace(/^\.?\//, "");
   const preserves = (preservePaths ?? []).map(normalize);
   const isPreservedRel = (rel: string) => preserves.some(p => isPreserveMatch(rel, p));

   // Preview + confirm
   const preview = {
      server: `${user}@${host}:${port}`,
      webroot: resolvedWebroot,
      zip: zipAbs,
      releaseDir: tmpRoot,
      localCount: localFiles.length,
      preserved: preserves,
      dryRun,
      mode: secure,
      domain,
   };
   await maybeConfirm(preview, confirm, yes);

   // 2) Connect FTP/FTPS
   const client = new Client(timeoutMs > 0 ? timeoutMs : 0);
   client.ftp.verbose = false;

   const access: AccessOptions = {
      host,
      user,
      password,
      port,
      secure: secure === "none" ? false : (secure === "implicit" ? "implicit" : true),
      secureOptions,
   };
   await client.access(access);
   await client.ensureDir(resolvedWebroot);
   await client.cd(resolvedWebroot);

   // 3) List remote tree (for delete & merge decisions)
   const remoteTree = await listRemoteTree(client, ".");
   const remoteFilesSet = new Set(remoteTree.files.map(x => x.rel)); // files only (rel to webroot)

   // Split locals by preserved
   const localNonPreserve = localFiles.filter(f => !isPreservedRel(f));
   const localPreserve = localFiles.filter(f => isPreservedRel(f));

   // 4) Phase A — delete remote files not in local (outside preserved), then upload non-preserved
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
      await safeRemoveFile(client, rel);
   }

   // Upload non-preserved (create dirs as needed)
   if (localNonPreserve.length) {
      console.log(pc.dim(`Phase A: uploading ${localNonPreserve.length} file(s) (outside preserved)`));
      const effConc = 1;
      if (concurrency > 1) console.log(pc.dim(`(FTP) concurrency > 1 requested; clamped to ${effConc}`));
      await uploadMany(client, tmpRoot, localNonPreserve, { concurrency: effConc, dryRun });
   }

   // 5) Phase B — merge into preserved paths: upload only files that don't exist on remote
   if (localPreserve.length) {
      const newPreserve = localPreserve.filter(rel => !remoteFilesSet.has(rel));
      console.log(pc.dim(`Phase B: merging ${newPreserve.length}/${localPreserve.length} new file(s) into preserved paths`));
      const effConc = 1;
      await uploadMany(client, tmpRoot, newPreserve, { concurrency: effConc, dryRun });
   }

   // 6) Remove empty remote directories (outside preserved) after deletions (best-effort)
   const remoteDirsDesc = remoteTree.dirs
      .map(x => x.rel)
      .filter(rel => !isPreservedRel(rel + "/")) // dir marker
      .sort((a, b) => b.length - a.length);

   let pruned = 0;
   for (const rel of remoteDirsDesc) {
      if (dryRun) { continue; }
      try {
         const list = await client.list(rel);
         if (!list.length) {
            await client.removeDir(rel);
            pruned++;
         }
      } catch { /* ignore if not empty / permission */ }
   }
   if (pruned) console.log(pc.dim(`Pruned ${pruned} empty remote director${pruned === 1 ? "y" : "ies"}.`));

   await client.close();

   // 7) Cleanup temp release
   try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }

   const ms = Date.now() - start;
   console.log(pc.green(`✔ FTP deploy done in ${Math.round(ms / 1000)}s`));
}

/* ------------------------------------------------------------------ */
/* Public API: Restore (FTP/FTPS)                                      */
/* ------------------------------------------------------------------ */

export async function restoreViaFTP(opts: RestoreFtpOpts) {
   const {
      host,
      user,
      password,
      domain,
      webroot,
      backupPath,
      preservePaths = ["uploads/", "storage/", ".well-known/", "robots.txt"],
      secure = "explicit",
      port = secure === "implicit" ? 990 : 21,
      secureOptions,
      dryRun = false,
      timeoutMs = 0,
      concurrency = 4,
      confirm = "auto",
      yes = false,
   } = opts;

   const resolvedWebroot = webroot ?? (domain ? deriveDefaultWebroot(user, domain) : undefined);
   if (!resolvedWebroot) {
      throw new Error("webroot not provided and cannot derive it: set either webroot or domain in your config.");
   }

   const backupAbs = path.isAbsolute(backupPath) ? backupPath : path.resolve(process.cwd(), backupPath);
   if (!fs.existsSync(backupAbs)) throw new Error(`Backup not found: ${backupAbs}`);

   const tmpRoot = await extractToTemp(backupAbs);        // supports .zip / .tar.gz
   const localRoot = await inferDocumentRoot(tmpRoot);    // prefer "public_html" → else tmpRoot
   const localFiles = await listLocalFiles(localRoot);

   const preserves = (preservePaths ?? []).map(normalizeRel);
   const isPreserved = (rel: string) => preserves.some(p => isPreserveMatch(rel, p));

   await maybeConfirm({
      server: `${user}@${host}:${port}`,
      webroot: resolvedWebroot,
      zip: backupAbs,
      releaseDir: localRoot,
      localCount: localFiles.length,
      preserved: preserves,
      dryRun,
      mode: secure,
      domain,
   }, confirm, yes);

   const client = new Client(timeoutMs > 0 ? timeoutMs : 0);
   await client.access({
      host,
      user,
      password,
      port,
      secure: secure === "none" ? false : (secure === "implicit" ? "implicit" : true),
      secureOptions,
   });
   await client.ensureDir(resolvedWebroot);
   await client.cd(resolvedWebroot);

   const remoteTree = await listRemoteTree(client, ".");
   const remoteFilesSet = new Set(remoteTree.files.map(x => x.rel));

   const localNonPreserve = localFiles.filter(f => !isPreserved(f));
   const localPreserve = localFiles.filter(f => isPreserved(f));

   // delete outside preserved
   const localNonPreserveSet = new Set(localNonPreserve);
   const remoteNonPreserve = remoteTree.files.filter(f => !isPreserved(f.rel));
   const toDelete = remoteNonPreserve.filter(x => !localNonPreserveSet.has(x.rel)).map(x => x.rel);

   if (toDelete.length) console.log(pc.dim(`Phase A: deleting ${toDelete.length} remote file(s)`));
   for (const rel of toDelete) {
      if (dryRun) { console.log(pc.dim(`  - rm ${rel}`)); continue; }
      await safeRemoveFile(client, rel);
   }

   // upload outside preserved
   if (localNonPreserve.length) {
      console.log(pc.dim(`Phase A: uploading ${localNonPreserve.length} file(s)`));
      const effConc = 1;
      await uploadMany(client, localRoot, localNonPreserve, { concurrency: effConc, dryRun });
   }

   // merge into preserved (new only)
   const newPreserve = localPreserve.filter(rel => !remoteFilesSet.has(rel));
   if (newPreserve.length) {
      console.log(pc.dim(`Phase B: merging ${newPreserve.length}/${localPreserve.length} file(s) into preserved`));
      const effConc = 1;
      await uploadMany(client, localRoot, newPreserve, { concurrency: effConc, dryRun });
   }

   await client.close();
   try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }

   console.log(pc.green(`✔ FTP restore complete`));
}

/* ------------------------------------------------------------------ */
/* CLI wrappers (optional)                                             */
/* ------------------------------------------------------------------ */

export async function cli() {
   const args = parseArgs(process.argv.slice(2));
   const get = (k: string, d?: string) => (k in args ? String(args[k]) : d);
   const req = (k: string) => {
      if (!(k in args)) throw new Error(`Missing --${k}`);
      return String(args[k]);
   };

   const secure: FtpSecurity = get("secure", "explicit") as any;
   const yes = truthyEnv(get("yes")) || truthyEnv(process.env.YES) || truthyEnv(process.env.FORCE);

   await uploadViaFTP({
      host: req("host"),
      domain: get("domain"),
      user: req("user"),
      password: get("pass") || process.env.ZIPPER_FTP_PASS || "",
      webroot: get("webroot"), // optional; can be derived from domain
      zipPath: req("zip"),
      preservePaths: split(get("preserve")),
      secure,
      port: get("port") ? Number(get("port")) : undefined,
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

export async function cliRestoreFTP() {
   const args = parseArgs(process.argv.slice(2)) as any;

   await restoreViaFTP({
      host: reqArg(args, "host"),
      domain: args["domain"],
      user: reqArg(args, "user"),
      password: args["pass"] || process.env.ZIPPER_FTP_PASS || "",
      webroot: args["webroot"], // optional; can be derived from domain
      backupPath: reqArg(args, "backup"),
      preservePaths: split(args["preserve"]),
      secure: (args["secure"] as FtpSecurity) || "explicit",
      port: args["port"] ? Number(args["port"]) : undefined,
      dryRun: !!args["dry-run"],
      concurrency: args["concurrency"] ? Number(args["concurrency"]) : 4,
      timeoutMs: args["timeout"] ? Number(args["timeout"]) : 0,
      confirm: args["confirm"] === "never" || args["confirm"] === "always" ? (args["confirm"] as any) : "auto",
      yes: truthyEnv(args["yes"]) || truthyEnv(process.env.YES),
   });

   function reqArg(a: Record<string, any>, k: string) {
      if (!(k in a)) throw new Error(`Missing --${k}`);
      return String(a[k]);
   }
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function split(v: unknown): string[] | undefined {
   if (v == null) return undefined;
   const s = String(v).trim();
   if (!s) return undefined;
   return s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}

async function unzipToTemp(zipPath: string): Promise<string> {
   const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zipper-ftp-"));
   await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: tmp }))
      .promise();
   return tmp;
}

async function extractToTemp(archive: string) {
   const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zipper-rest-ftp-"));
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

async function listRemoteTree(client: Client, relDir: string): Promise<RemoteTree> {
   const files: RemoteTree["files"] = [];
   const dirs: RemoteTree["dirs"] = [];

   async function walk(cwdRel: string) {
      let list: FileInfo[];
      try {
         list = await client.list(cwdRel);
      } catch {
         return;
      }
      for (const it of list) {
         const rel = path.posix.join(cwdRel === "." ? "" : cwdRel, it.name);
         if (it.isDirectory) {
            dirs.push({ rel });
            await walk(rel);
         } else {
            files.push({ rel, size: it.size ?? 0 });
         }
      }
   }

   await walk(relDir);
   return { files, dirs };
}

function isPreserveMatch(rel: string, preserve: string) {
   // If preserve ends with '/', treat as directory prefix; else exact file
   if (preserve.endsWith("/")) {
      const p = preserve.replace(/\/+$/, "") + "/";
      return rel.startsWith(p);
   }
   return rel === preserve;
}

async function safeRemoveFile(client: Client, rel: string) {
   try {
      await client.remove(rel);
   } catch {
      // try dir?
      try { await client.removeDir(rel); } catch { /* ignore */ }
   }
}

async function uploadMany(
   client: Client,
   localRoot: string,
   relFiles: string[],
   opts: { concurrency: number; dryRun: boolean }
) {
   const limit = Math.max(1, Math.min(16, opts.concurrency | 0));
   let active = 0;
   let idx = 0;
   let uploaded = 0;

   return new Promise<void>((resolve, reject) => {
      const next = () => {
         if (idx >= relFiles.length && active === 0) return resolve();
         while (active < limit && idx < relFiles.length) {
            const rel = relFiles[idx++];
            active++;
            (async () => {
               try {
                  const local = path.join(localRoot, rel.replaceAll("/", path.sep));
                  const dirRel = path.posix.dirname(rel);
                  if (!opts.dryRun) {
                     if (dirRel && dirRel !== ".") await client.ensureDir(dirRel);
                     await client.uploadFrom(local, rel);
                  } else {
                     console.log(pc.dim(`  + up ${rel}`));
                  }
                  uploaded++;
                  if (uploaded % 250 === 0) console.log(pc.dim(`  … uploaded ${uploaded}/${relFiles.length}`));
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

function truthyEnv(v: any) {
   if (v == null) return false;
   const s = String(v).toLowerCase();
   return s === "1" || s === "true" || s === "yes" || s === "y";
}

async function maybeConfirm(pre: {
   server: string; webroot: string; zip: string; releaseDir: string;
   localCount: number; preserved: string[]; dryRun: boolean; mode: string; domain?: string;
}, confirm: "auto" | "always" | "never", yes: boolean) {
   const interactive = process.stdin.isTTY && process.stdout.isTTY;
   if (confirm === "never") return;
   if (!interactive && !yes) {
      throw new Error("Non-interactive session. Pass --yes (or YES=1) to proceed.");
   }
   if (interactive && (confirm === "always" || (confirm === "auto" && !yes))) {
      const size = await fileSize(pre.zip);
      const human = humanSize(size);
      console.log("");
      console.log("============ DEPLOY PREVIEW (FTP) ============");
      console.log(` Server         : ${pre.server}`);
      console.log(` Mode           : ${pre.mode}`);
      if (pre.domain) console.log(` Domain         : ${pre.domain}`);
      console.log(` Webroot        : ${pre.webroot}`);
      console.log(` ZIP            : ${short(pre.zip)} (${human})`);
      console.log(` Exploded dir   : ${short(pre.releaseDir)}`);
      console.log(` Local files    : ${pre.localCount}`);
      console.log(` Preserve paths :`);
      for (const p of pre.preserved) console.log(`   • ${p}`);
      console.log(` Delete mode    : Phase A deletes remote files not present (outside preserved)`);
      console.log(` DRY RUN        : ${pre.dryRun ? "1" : "0"}`);
      console.log("==============================================");
      console.log("");
      const rl = createInterface({ input, output });
      try {
         const ans = await rl.question("Proceed? [y/N] ");
         if (!/^(y|yes)$/i.test(ans.trim())) throw new Error("Aborted by user.");
      } finally {
         rl.close();
      }
   }
}

async function fileSize(p: string) {
   const st = await fs.promises.stat(p);
   return st.size;
}
function humanSize(bytes: number) {
   const units = ["B", "KB", "MB", "GB", "TB"];
   let i = 0, n = bytes;
   while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
   return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function short(p: string) { return p.replace(process.cwd(), "."); }
function normalizeRel(p: string) { return p.replaceAll("\\", "/").replace(/^\.?\//, ""); }

function deriveDefaultWebroot(user: string, domain: string) {
   const u = (user || "user").trim();
   return `/home/${u}/web/${domain}/public_html`;
}