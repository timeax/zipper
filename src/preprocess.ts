// src/preprocess.ts
import path from "node:path";
import { promises as fs } from "node:fs";
import picomatch from "picomatch";
import { ZipConfig, FileStats, ProcessedEntry, PreprocessHandler, ProcessReturn } from "./types";
//@ts-ignore
import { isText as detectText } from "istextorbinary"; // tiny helper you likely have (or add)

type RunOpts = { strict: boolean };

export async function runPreprocessPipeline(
   files: string[],
   root: string,
   cfg: ZipConfig,
   opts: RunOpts
): Promise<{ entries: ProcessedEntry[]; changedCount: number; omittedCount: number }> {
   const pre = cfg.preprocess!;
   const includeMatchers = (pre.includes ?? ["**/*"]).map(glob => picomatch(glob));
   const excludeMatchers = (pre.excludes ?? []).map(glob => picomatch(glob));
   const explicitFiles = new Set((pre.files ?? []).map(f => path.normalize(f)));

   const entries: ProcessedEntry[] = [];
   let changed = 0;
   let omitted = 0;

   const handlers: PreprocessHandler[] = Array.isArray(pre.handlers) ? pre.handlers : [];

   for (const abs of files) {
      const rel = path.relative(root, abs).replaceAll("\\", "/");
      const zipPathInitial = rel; // initial mapping; groups could change this later

      // compute stats
      const st = await fs.stat(abs);
      const stats: FileStats = {
         abs,
         rel,
         zipPath: zipPathInitial,
         dir: path.dirname(rel),
         base: path.basename(rel),
         name: path.parse(rel).name,
         ext: path.extname(rel),
         size: st.size,
         mtimeMs: st.mtimeMs,
         isText: true, // set below
      };

      // Should this file be considered?
      const isExplicit = explicitFiles.has(path.normalize(rel));
      const inIncludes = includeMatchers.length ? includeMatchers.some(m => m(rel)) : true;
      const inExcludes = excludeMatchers.some(m => m(rel));
      const candidate = isExplicit || (inIncludes && !inExcludes);

      if (!candidate) {
         // not in preprocess scope; include unmodified as a path entry (not counted as change)
         entries.push({ sourcePath: abs, zipPath: zipPathInitial });
         continue;
      }

      // Load content
      let buf = await fs.readFile(abs);

      // Binary guard
      const isText = detectText(stats.base, buf);
      stats.isText = isText;
      const binaryMode = pre.binaryMode ?? "skip";
      if (!isText) {
         if (binaryMode === "skip") {
            // include as-is, no preprocessing
            entries.push({ sourcePath: abs, zipPath: zipPathInitial });
            continue;
         }
         // "pass" means run handlers but they probably won’t modify; "buffer" is same as pass here
      }

      // Size guard
      const maxBytes = pre.maxBytes ?? Infinity;
      if (stats.size > maxBytes) {
         entries.push({ sourcePath: abs, zipPath: zipPathInitial });
         continue;
      }

      // Context
      const ctx = {
         root,
         env: process.env,
         buildId: new Date().toISOString(),
         utils: {
            globMatch: (g: string, s: string) => picomatch(g)(s),
            isText: (b: Buffer, name: string) => detectText(b, name),
         },
      };

      // Run handlers in sequence
      let zipPath = zipPathInitial;
      let content: Buffer = buf;
      let dropped = false;

      for (const h of handlers) {
         const res = await withTimeout(() => Promise.resolve(h({ stats, content, ctx })), pre.timeoutMs ?? 10000);
         if (res === null) { dropped = true; break; }
         if (res === undefined) continue;
         if (typeof (res as any)?.content !== "undefined") {
            const obj = res as { content: Buffer | string; path?: string };
            content = Buffer.isBuffer(obj.content) ? obj.content : Buffer.from(String(obj.content));
            if (obj.path) zipPath = normalizeZipPath(obj.path);
            changed++;
         } else if (Buffer.isBuffer(res) || typeof res === "string") {
            content = Buffer.isBuffer(res) ? res : Buffer.from(String(res));
            changed++;
         } else {
            // unknown return; ignore
         }
      }

      if (dropped) { omitted++; continue; }

      // If changed (content or path), emit as content entry; else emit as source path
      if (changed > 0 || zipPath !== zipPathInitial) {
         entries.push({ zipPath, content });
      } else {
         entries.push({ sourcePath: abs, zipPath });
      }
   }

   return { entries, changedCount: changed, omittedCount: omitted };
}

function normalizeZipPath(p: string) {
   return p.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
   if (!Number.isFinite(ms) || ms <= 0) return fn();
   let t: NodeJS.Timeout;
   return await Promise.race([
      fn(),
      new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`preprocess timeout after ${ms}ms`)), ms as any); })
   ]).finally(() => { if (t!) clearTimeout(t!); });
}