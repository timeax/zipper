import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { globby } from "globby";
import ignore from "ignore";
import pc from "picocolors";
import crypto from "node:crypto";
import cliProgress from "cli-progress";
import type { ProcessedEntry, ZipConfig } from "./types.js";

function stableSort(arr: string[]) { return [...arr].sort((a, b) => a.localeCompare(b)); }
function readGitignore(root: string): string[] {
   const gi = path.join(root, ".gitignore");
   if (!fs.existsSync(gi)) return [];
   return fs.readFileSync(gi, "utf8").split(/\r?\n/);
}

// very lightweight glob detector; avoids adding a dep
const GLOB_CHARS = /[*?[\]{}()!+@]|\\|[/]?\*\*[/]?/;
const looksLikeGlob = (p: string) => GLOB_CHARS.test(p);
const hasAnyGlob = (patterns?: string[]) => !!patterns?.some(looksLikeGlob);
const normRel = (p: string) => p.replaceAll("\\", "/").replace(/^\.?\//, "");

export async function buildFileListWithGlob(cfg: ZipConfig, extraList: string[], extraIgnore: string[]): Promise<string[]> {
   const root = path.resolve(process.cwd(), cfg.root ?? ".");

   const include = (cfg.include?.length ? cfg.include : ["**/*"]).map(normRel);

   // ===== FAST PATH: includes are all literal file paths (post smart-merge) =====
   if (!hasAnyGlob(include)) {
      // Merge includes + --from list (unique), keep only existing files
      const merged = Array.from(new Set([...include, ...extraList.map(normRel)]));
      const existing = merged.filter(rel => {
         try { return fs.statSync(path.join(root, rel)).isFile(); }
         catch { return false; }
      });

      // Apply ignore rules
      const ig = ignore();
      if (cfg.respectGitignore) ig.add(readGitignore(root));
      ig.add(cfg.exclude ?? []);
      ig.add(extraIgnore);

      // Start with excluded view…
      let final = existing.filter(f => !ig.ignores(f));

      // If order is exclude,include → includes punch holes back in.
      // In literal mode, "includes" == existing list, so the final set is just `existing`.
      if (cfg.order?.join(",") === "exclude,include") {
         final = existing;
      }

      // Deterministic ordering if requested
      return cfg.deterministic ? stableSort(final) : final;
   }

   console.log(include.filter(looksLikeGlob));
   // ===== ORIGINAL PATH: globbing is needed =====
   const candidates = await globby(include, {
      cwd: root,
      dot: !!cfg.dot,
      followSymbolicLinks: !!cfg.followSymlinks,
      onlyFiles: true
   });

   const ig = ignore();
   if (cfg.respectGitignore) ig.add(readGitignore(root));
   ig.add(cfg.exclude ?? []);
   ig.add(extraIgnore);

   const merged = Array.from(new Set([...candidates, ...extraList.map(normRel)]));
   let final = merged.filter(f => !ig.ignores(f));

   if (cfg.order?.join(",") === "exclude,include" && cfg.include?.length) {
      // Re-run includes to re-add anything excluded. (Here they may be globs.)
      const reincluded = await globby(cfg.include, {
         cwd: root,
         dot: !!cfg.dot,
         followSymbolicLinks: !!cfg.followSymlinks,
         onlyFiles: true
      });
      const set = new Set(final);
      for (const f of reincluded) set.add(normRel(f));
      final = [...set];
   }

   return cfg.deterministic ? stableSort(final) : final;
}

/**
 * FAST path for smart-merge:
 * - Assumes cfg.include is a fully materialized list of relative file paths.
 * - No globbing, no fs.stat per file.
 * - Applies ignore rules; supports order = ["exclude","include"] by re-adding.
 */
export async function buildFileList(cfg: ZipConfig, extraList: string[], extraIgnore: string[]): Promise<string[]> {
  const root = path.resolve(process.cwd(), cfg.root ?? ".");

  // 1) Merge includes + --from list (both expected to be literal paths), de-dupe
  const include = (cfg.include ?? []).map(normRel);
  const merged = Array.from(new Set([
    ...include,
    ...extraList.map(normRel),
  ]));

  // 2) Build ignore set (gitignore + config excludes + extraIgnore)
  const ig = ignore();
  if (cfg.respectGitignore) ig.add(readGitignore(root));
  ig.add(cfg.exclude ?? []);     // should be [] after smart-merge, but safe to keep
  ig.add(extraIgnore);

  // 3) Apply excludes
  let final = merged.filter(f => !ig.ignores(f));

  // 4) If order is exclude,include → reinclusion: since our "includes" are the literal list,
  //    reinclusion is just the full merged list again.
  if (cfg.order?.join(",") === "exclude,include") {
    final = merged;
  }

  // 5) Stable order if requested
  return cfg.deterministic ? stableSort(final) : final;
}
/* ---------- small helpers ---------- */
function zipPathNormalize(p: string) {
   return String(p).replaceAll("\\", "/").replace(/^\.?\//, "");
}
function isContentLike(x: any): x is Buffer | Uint8Array | string {
   return Buffer.isBuffer(x) || x instanceof Uint8Array || typeof x === "string";
}
function hashBuffer(buf: Buffer | Uint8Array) {
   return crypto.createHash("sha256").update(buf).digest("hex");
}

/* ---------- manifest over normalized entries ---------- */
async function computeManifestFromEntries(entries: ProcessedEntry[]) {
   const sorted = [...entries].sort((a, b) =>
      zipPathNormalize(a.zipPath).localeCompare(zipPathNormalize(b.zipPath))
   );

   const files: { path: string; size: number; sha256: string }[] = [];
   for (const e of sorted) {
      if ("content" in e && isContentLike((e as any).content)) {
         const c = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content);
         files.push({ path: e.zipPath, size: c.length, sha256: hashBuffer(c) });
      } else if ("sourcePath" in e && typeof (e as any).sourcePath === "string") {
         const data = await fs.promises.readFile((e as any).sourcePath);
         files.push({ path: e.zipPath, size: data.length, sha256: hashBuffer(data) });
      }
   }

   return {
      createdAt: new Date().toISOString(),
      files,
      totalFiles: files.length,
      totalBytes: files.reduce((acc, f) => acc + f.size, 0),
      algorithm: "sha256",
      version: 1,
   };
}

/* ---------- the fix ---------- */
export async function writeZip(cfg: ZipConfig, files: string[] | ProcessedEntry[]) {
   const root = path.resolve(process.cwd(), cfg.root ?? ".");
   const outPath = path.resolve(process.cwd(), cfg.out);
   fs.mkdirSync(path.dirname(outPath), { recursive: true });

   // Normalize inputs → strict {zipPath, (content|sourcePath)} list
   const rawEntries: ProcessedEntry[] = Array.isArray(files) && typeof (files as any)[0] === "string"
      ? (files as string[]).map(rel => ({
         zipPath: zipPathNormalize(rel),
         sourcePath: path.join(root, rel),
      }))
      : (files as ProcessedEntry[]).map((e) => {
         const zipPath = zipPathNormalize(e.zipPath);
         if ("content" in e && isContentLike((e as any).content)) {
            // strictly treat as content
            return { zipPath, content: (e as any).content } as ProcessedEntry;
         }
         // else treat as file entry; coerce to string
         let sp: any = (e as any).sourcePath;
         if (typeof sp !== "string") {
            // If a Buffer/URL somehow slipped in, bail to a clear error
            throw new TypeError(`Invalid sourcePath for ${zipPath}: expected string, got ${typeof sp}`);
         }
         const abs = path.isAbsolute(sp) ? sp : path.join(root, sp);
         return { zipPath, sourcePath: abs } as ProcessedEntry;
      });

   // last-one-wins de-dup by zipPath
   const lastWins = new Map<string, ProcessedEntry>();
   for (const e of rawEntries) lastWins.set(e.zipPath, e);
   const entries = Array.from(lastWins.values());

   // Optional manifest
   let manifest: any | undefined;
   if (cfg.manifest !== false) {
      manifest = await computeManifestFromEntries(entries);
   }

   const output = fs.createWriteStream(outPath);
   const archive = archiver("zip", { zlib: { level: 9 } });

   const bar = new cliProgress.SingleBar({ hideCursor: true }, cliProgress.Presets.shades_classic);

   archive.on("progress", (p) => {
      const total = p.entries.total || entries.length;
      const processed = p.entries.processed || 0;
      if (!bar.isActive) bar.start(total, processed);
      else bar.update(processed);
   });

   archive.on("warning", (err) => console.warn(pc.yellow("archiver:"), err.message));
   archive.on("error", (err) => { throw err; });

   archive.pipe(output);

   if (manifest) {
      archive.append(JSON.stringify(manifest, null, 2), { name: "MANIFEST.json" });
   }

   // Append entries
   for (const e of entries) {
      if ("content" in e && isContentLike((e as any).content)) {
         const c = Buffer.isBuffer((e as any).content)
            ? (e as any).content
            : Buffer.from((e as any).content);
         archive.append(c, { name: e.zipPath });
      } else {
         // Guard: file path must be string
         if (typeof (e as any).sourcePath !== "string") {
            throw new TypeError(`Invalid sourcePath for ${e.zipPath}: not a string`);
         }
         try {
            archive.file((e as any).sourcePath, { name: e.zipPath, stats: fs.statSync((e as any).sourcePath) });
         } catch (err) {
            console.warn(pc.yellow(`skipping missing file: ${e.zipPath}`));
         }
      }
   }

   await archive.finalize();
   bar.stop();

   if (manifest) {
      const manifestOut = cfg.manifestPath
         ? path.resolve(process.cwd(), cfg.manifestPath)
         : path.join(path.dirname(outPath), path.basename(outPath, ".zip") + ".manifest.json");
      fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2));

      const zhash = crypto.createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
      fs.writeFileSync(outPath + ".sha256", `${zhash}  ${path.basename(outPath)}\n`);
   }

   return outPath;
}