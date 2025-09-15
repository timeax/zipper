// src/groups.ts
import path from "node:path";
import picomatch from "picomatch";
import type { ZipConfig, GroupConfig } from "./types";

export function buildGroupZipMapper(cfg: ZipConfig) {
   const groups = cfg.groups ?? {};

   const compiled = Object.entries(groups).map(([name, g]) => {
      const target = normalizeTarget(g.target);
      const include = (g.include ?? []).map(glob => picomatch(glob, { dot: true }));
      const exclude = (g.exclude ?? []).map(glob => picomatch(glob, { dot: true }));
      const filesSet = new Set<string>((g.files ?? []).map(normRel)); // NEW
      const priority = Number.isFinite(g.priority) ? (g.priority as number) : 0;
      return { name, target, include, exclude, filesSet, priority };
   });

   // sort asc by priority; we’ll pick the last winner among equal priorities
   compiled.sort((a, b) => a.priority - b.priority);

   function map(relPath: string): string {
      const rel = normRel(relPath);
      let winnerIdx = -1;
      let winnerMode: "file" | "glob" | null = null;

      for (let i = 0; i < compiled.length; i++) {
         const g = compiled[i];

         // 1) Explicit file whitelist takes precedence within this group
         if (g.filesSet.has(rel)) {
            if (winnerIdx < 0 || compiled[i].priority >= compiled[winnerIdx].priority) {
               winnerIdx = i;
               winnerMode = "file";
            }
            continue;
         }

         // 2) Otherwise, use include/exclude glob logic
         if (!g.include.some(m => m(rel))) continue;
         if (g.exclude.some(m => m(rel))) continue;
         if (winnerIdx < 0 || compiled[i].priority >= compiled[winnerIdx].priority) {
            winnerIdx = i;
            winnerMode = "glob";
         }
      }

      if (winnerIdx === -1) return rel; // no group matched → keep original path

      const g = compiled[winnerIdx];
      if (winnerMode === "file") {
         // explicit file → drop parent folders; keep only basename under target
         return joinZip(g.target, path.posix.basename(rel));
      }
      // glob mode → keep relative structure under target
      return joinZip(g.target, rel);
   }

   return { map, hasGroups: compiled.length > 0 };
}

function normalizeTarget(t: string): string {
   if (!t) return "";
   let x = t.replaceAll("\\", "/");
   if (x.startsWith("./")) x = x.slice(2);
   if (x.startsWith("/")) x = x.slice(1);
   if (x !== "" && !x.endsWith("/")) x += "/";
   return x;
}

function joinZip(prefix: string, rel: string): string {
   const p = prefix ? (prefix.endsWith("/") ? prefix : prefix + "/") : "";
   return (p + rel).replace(/\/{2,}/g, "/");
}

function normRel(p: string): string {
   return p.replaceAll("\\", "/").replace(/^\.?\//, "");
}