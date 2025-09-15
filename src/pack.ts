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

export async function buildFileList(cfg: ZipConfig, extraList: string[], extraIgnore: string[]): Promise<string[]> {
   const root = path.resolve(process.cwd(), cfg.root ?? ".");

   const include = cfg.include?.length ? cfg.include : ["**/*"];
   const candidates = await globby(include, { cwd: root, dot: !!cfg.dot, followSymbolicLinks: !!cfg.followSymlinks, onlyFiles: true });

   const ig = ignore();
   if (cfg.respectGitignore) ig.add(readGitignore(root));
   ig.add(cfg.exclude ?? []);
   ig.add(extraIgnore);

   const merged = Array.from(new Set([...candidates, ...extraList]));
   let final = merged.filter(f => !ig.ignores(f));

   if (cfg.order?.join(",") === "exclude,include" && cfg.include?.length) {
      const reincluded = await globby(cfg.include, { cwd: root, dot: !!cfg.dot, followSymbolicLinks: !!cfg.followSymlinks, onlyFiles: true });
      const set = new Set(final);
      for (const f of reincluded) set.add(f);
      final = [...set];
   }

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