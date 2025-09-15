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

// NEW: compute per-file SHA256 and optional MANIFEST.json
async function computeManifest(root: string, files: string[]) {
   const entries: { path: string; size: number; sha256: string; }[] = [];
   for (const f of files) {
      const full = path.join(root, f);
      const h = crypto.createHash("sha256");
      const buf = fs.readFileSync(full);
      h.update(buf);
      entries.push({ path: f, size: buf.length, sha256: h.digest("hex") });
   }
   return { generatedAt: new Date().toISOString(), count: files.length, entries };
}


/**
 * Backward-compatible writer:
 * - legacy: files: string[] (RELATIVE to cfg.root)
 * - new:    files: ProcessedEntry[] (each has zipPath + sourcePath OR content)
 */
export async function writeZip(cfg: ZipConfig, files: string[] | ProcessedEntry[]) {
   const root = path.resolve(process.cwd(), cfg.root ?? ".");
   const outPath = path.resolve(process.cwd(), cfg.out);
   fs.mkdirSync(path.dirname(outPath), { recursive: true });

   // Normalize input to a single entries list
   const entries: ProcessedEntry[] = Array.isArray(files) && typeof (files as any)[0] === "string"
      ? (files as string[]).map(rel => ({
         sourcePath: path.join(root, rel),
         zipPath: rel.replaceAll("\\", "/"),
      }))
      : (files as ProcessedEntry[]);

   // Optional manifest
   let manifest: any | undefined;
   if (cfg.manifest !== false) {
      manifest = await computeManifestFromEntries(entries);
   }

   const output = fs.createWriteStream(outPath);
   const archive = archiver("zip", { zlib: { level: 9 } });

   // Progress bar
   const bar = new cliProgress.SingleBar({ hideCursor: true }, cliProgress.Presets.shades_classic);
   let total = entries.length;
   let processed = 0;

   archive.on("progress", (p) => {
      // p.entries.total, p.entries.processed, p.fs.totalBytes, p.fs.processedBytes
      total = p.entries.total || total;
      processed = p.entries.processed || processed;
      if (!bar.isActive) bar.start(total, processed);
      else bar.update(processed);
   });

   archive.on("warning", err => console.warn(pc.yellow("archiver:"), err.message));
   archive.on("error", err => { throw err; });

   archive.pipe(output);

   // Embed manifest inside the zip as MANIFEST.json
   if (manifest) {
      archive.append(JSON.stringify(manifest, null, 2), { name: "MANIFEST.json" });
   }

   // Add files
   for (const e of entries) {
      if ("content" in e) {
         archive.append(e.content, { name: e.zipPath });
      } else {
         // Ensure we pass absolute disk path, but the name inside zip should be zipPath
         archive.file(e.sourcePath, { name: e.zipPath, stats: fs.statSync(e.sourcePath) });
      }
   }

   await archive.finalize();
   bar.stop();

   // External manifest (optional + checksum file for the zip)
   if (manifest) {
      const manifestOut =
         cfg.manifestPath
            ? path.resolve(process.cwd(), cfg.manifestPath)
            : path.join(path.dirname(outPath), path.basename(outPath, ".zip") + ".manifest.json");
      fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2));

      // zip sha256
      const zhash = crypto.createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
      fs.writeFileSync(outPath + ".sha256", `${zhash}  ${path.basename(outPath)}\n`);
   }

   return outPath;
}

/** Build a manifest that works for both disk-backed and in-memory entries. */
async function computeManifestFromEntries(entries: ProcessedEntry[]) {
   // Keep stable order (zipPath ascending)
   const sorted = [...entries].sort((a, b) => a.zipPath.localeCompare(b.zipPath));

   const files = [];
   for (const e of sorted) {
      let size: number;
      let sha256: string;

      if ("content" in e) {
         size = e.content.length;
         sha256 = hashBuffer(e.content);
      } else {
         const fsp = fs.promises;
         const data = await fsp.readFile(e.sourcePath);
         size = data.length;
         sha256 = hashBuffer(data);
      }

      files.push({
         path: e.zipPath,
         size,
         sha256,
      });
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

function hashBuffer(buf: Buffer) {
   return crypto.createHash("sha256").update(buf).digest("hex");
}

