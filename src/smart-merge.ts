// src/smart-merge.ts
import path from "node:path";
import fs from "node:fs";
import picomatch from "picomatch";
import { globby } from "globby";
import type { ZipConfig } from "./types.js";
import { PRESETS } from "./presets.js";
import pc from "picocolors";
import cliProgress from "cli-progress";

type OrderHint = Readonly<["include", "exclude"] | ["exclude", "include"]>;

export type SmartMergeOptions = {
   /** If true, show a progress bar while deciding winners */
   progress?: boolean;
   /** Optional logger; default prints with a dim [smart-merge] prefix */
   log?: (msg: string) => void;
   /** Update frequency for progress (files per tick). Default: 500 */
   tickEvery?: number;
   /** Label to prefix phase lines */
   label?: string;
};

type Source = {
   name: string;            // "preset:<name>" | "user"
   tier: number;            // higher tier wins (presets in array order, then user)
   order: OrderHint;
   include: string[];       // globs
   exclude: string[];       // globs
   files: string[];         // explicit file paths (normalized)
   groups?: NonNullable<ZipConfig["groups"]>;
};

type Signal = {
   kind: "include" | "exclude";
   tier: number;
   seq: number;             // strictly increasing within a source (later = stronger)
   order: OrderHint;
   name: string;            // source label
   match: (rel: string) => boolean;
};

const normRel = (p: string) => p.replaceAll("\\", "/").replace(/^\.?\//, "");
const normArr = (a?: string[]) => (a ?? []).map(normRel);
const uniq = <T,>(xs: T[] | undefined) => Array.from(new Set(xs ?? []));
const union = <T,>(...arrs: (T[] | undefined)[]) => uniq(arrs.flatMap(a => a ?? []));

/* -------------------------------- groups merge -------------------------------- */

function mergeGroups(a?: ZipConfig["groups"], b?: ZipConfig["groups"]): ZipConfig["groups"] | undefined {
   const out: NonNullable<ZipConfig["groups"]> = {};
   const names = uniq([...(a ? Object.keys(a) : []), ...(b ? Object.keys(b) : [])]);
   for (const name of names) {
      const ga = (a?.[name] ?? {}) as any;
      const gb = (b?.[name] ?? {}) as any;
      const target = gb.target ?? ga.target ?? "";
      const priority = gb.priority ?? ga.priority ?? 0;

      const include = union(ga.include, gb.include);
      const exclude = union(ga.exclude, gb.exclude);
      const files = union(ga.files, gb.files);

      const g: any = { target, priority };
      if (include.length) g.include = include;
      if (exclude.length) g.exclude = exclude;
      if (files.length) g.files = files;

      // Require at least one of include/files
      if (!g.include && !g.files) continue;

      out[name] = g;
   }
   return Object.keys(out).length ? out : undefined;
}

/* ------------------------------ sources & signals ----------------------------- */

function sourcesFromPresetsAndUser(cfg: ZipConfig, root: string): Source[] {
   const presetSources: Source[] = (cfg.presets ?? []).map((pname, i) => {
      const p: Partial<ZipConfig> & { files?: string[] } = (PRESETS as any)[pname] ?? {};
      return {
         name: `preset:${pname}`,
         tier: i,
         order: (p.order ?? cfg.order ?? ["include", "exclude"]) as OrderHint,
         include: normArr(p.include),
         exclude: normArr(p.exclude),
         files: normArr((p as any).files),
         groups: (p as any).groups,
      };
   });

   // User tier (after last preset)
   const userTier = (cfg.presets?.length ?? 0);

   // groups.*.files -> explicit includes at user tier
   const groupFiles = (() => {
      const g = cfg.groups ?? {};
      const all = new Set<string>();
      for (const k of Object.keys(g)) for (const f of (g[k].files ?? [])) all.add(normRel(f));
      return Array.from(all);
   })();

   // ignoreFiles content will be merged by loadConfig before calling us (we still read extra here if needed)
   const userSource: Source = {
      name: "user",
      tier: userTier,
      order: cfg.order as OrderHint,
      include: normArr(cfg.include),
      exclude: normArr(cfg.exclude),
      files: groupFiles,
      groups: cfg.groups,
   };

   return [...presetSources, userSource];
}

function compileSignals(sources: Source[]): Signal[] {
   const sigs: Signal[] = [];
   for (const src of sources) {
      let seq = 0;
      for (const g of src.include) {
         const m = picomatch(g, { dot: true });
         sigs.push({ kind: "include", tier: src.tier, seq: seq++, order: src.order, name: src.name, match: m });
      }
      for (const g of src.exclude) {
         const m = picomatch(g, { dot: true });
         sigs.push({ kind: "exclude", tier: src.tier, seq: seq++, order: src.order, name: src.name, match: m });
      }
      for (const f of src.files) {
         const rel = normRel(f);
         const m = (x: string) => normRel(x) === rel;
         sigs.push({ kind: "include", tier: src.tier, seq: seq++, order: src.order, name: src.name, match: m });
      }
   }
   sigs.sort((a, b) => (a.tier - b.tier) || (a.seq - b.seq));
   return sigs;
}

function decideFor(rel: string, signals: Signal[]): Signal | undefined {
   let winner: Signal | undefined;
   for (const s of signals) {
      if (!s.match(rel)) continue;
      if (!winner) { winner = s; continue; }
      if (s.tier > winner.tier) { winner = s; continue; }
      if (s.tier === winner.tier) {
         if (s.seq > winner.seq) winner = s;
         else if (s.seq === winner.seq) {
            if (s.order[0] === "exclude" && s.kind === "include" && winner.kind === "exclude") winner = s;
            else if (s.order[0] === "include" && s.kind === "exclude" && winner.kind === "include") winner = s;
         }
      }
   }
   return winner;
}

/* ---------------------------------- universe --------------------------------- */

async function buildUniverse(
   root: string,
   sources: Source[],
   opts: { dot: boolean; followSymlinks: boolean; },
   log: (m: string) => void
): Promise<{ universe: string[]; stats: { includeGlobs: number; explicitFiles: number } }> {
   const includeGlobs = new Set<string>();
   const explicitFiles = new Set<string>();
   for (const s of sources) {
      for (const g of s.include) includeGlobs.add(g);
      for (const f of s.files) explicitFiles.add(f);
   }

   if (includeGlobs.size === 0 && explicitFiles.size === 0) includeGlobs.add("**/*");

   const t0 = Date.now();
   log(`scan: globby(${includeGlobs.size} globs) …`);
   const fromGlobs = includeGlobs.size
      ? await globby(Array.from(includeGlobs), {
         cwd: root,
         dot: opts.dot,
         followSymbolicLinks: opts.followSymlinks,
         onlyFiles: true,
      })
      : [];
   const t1 = Date.now();

   const fromFiles = Array.from(explicitFiles).filter(f => fs.existsSync(path.join(root, f)));
   const universe = Array.from(new Set([...fromGlobs.map(normRel), ...fromFiles.map(normRel)]));

   log(`scan: ${pc.bold(String(universe.length))} candidates  (globs: ${fromGlobs.length}, explicit: ${fromFiles.length})  in ${t1 - t0}ms`);
   return { universe, stats: { includeGlobs: includeGlobs.size, explicitFiles: explicitFiles.size } };
}

/* ------------------------------ public API: apply ---------------------------- */

export async function applySmartMergeToConfig(
   cfg: ZipConfig,
   rootAbs?: string,
   opts: SmartMergeOptions = {}
): Promise<string[]> {
   const log: (m: string) => void =
      opts.log ?? ((m) => console.log(pc.dim(`[smart-merge]`), m));
   const label = opts.label ? `[${opts.label}] ` : "";

   const root = rootAbs ?? path.resolve(process.cwd(), cfg.root ?? ".");
   log(`${label}start (presets: ${cfg.presets?.length ?? 0})`);

   // (1) Build sources from presets + user (before mutation)
   const tSrc0 = Date.now();
   const sources = sourcesFromPresetsAndUser(cfg, root);
   const tSrc1 = Date.now();
   log(`${label}sources: ${sources.length} tier(s) in ${tSrc1 - tSrc0}ms`);

   // (2) Deep-merge groups across presets → user and write back
   const g0 = Date.now();
   const mergedPresetGroups = sources
      .filter(s => s.name.startsWith("preset:"))
      .map(s => s.groups)
      .reduce((acc, g) => mergeGroups(acc, g), undefined as ZipConfig["groups"]);
   cfg.groups = mergeGroups(mergedPresetGroups, sources[sources.length - 1]?.groups) ?? cfg.groups;
   const g1 = Date.now();
   log(`${label}groups: merged in ${g1 - g0}ms  (${Object.keys(cfg.groups ?? {}).length} group(s))`);

   // (3) Universe + signals
   const u = await buildUniverse(root, sources, { dot: !!cfg.dot, followSymlinks: !!cfg.followSymlinks }, log);
   const s0 = Date.now();
   const signals = compileSignals(sources);
   const s1 = Date.now();
   log(`${label}signals: ${signals.length} rule(s) in ${s1 - s0}ms`);

   // (4) Decide winners (with optional progress)
   const bar = new cliProgress.SingleBar({ hideCursor: true }, cliProgress.Presets.shades_classic);
   const total = u.universe.length;
   const tickEvery = Math.max(1, opts.tickEvery ?? 500);

   const decideT0 = Date.now();
   const selectedSet = new Set<string>();
   if (opts.progress && total > 0) bar.start(total, 0);

   for (let i = 0; i < total; i++) {
      const rel = u.universe[i];
      const w = decideFor(rel, signals);
      if (w?.kind === "include") selectedSet.add(rel);
      if (opts.progress && (i + 1 === total || (i + 1) % tickEvery === 0)) bar.update(i + 1);
   }
   if (opts.progress && bar.isActive) bar.stop();
   const decideT1 = Date.now();

   // (5) Materialize + backup
   const selected = Array.from(selectedSet);
   if (cfg.deterministic) selected.sort((a, b) => a.localeCompare(b));

   (cfg as any).backup = {
      include: cfg.include ?? undefined,
      exclude: cfg.exclude ?? undefined,
      presets: cfg.presets ?? undefined,
      groups: cfg.groups ?? undefined,
      respectGitignore: cfg.respectGitignore ?? undefined,
      ignoreFiles: cfg.ignoreFiles ?? undefined,
      order: cfg.order ?? undefined,
   };

   cfg.include = selected;
   cfg.exclude = [];
   cfg.respectGitignore = false;
   cfg.ignoreFiles = [];
   cfg.order = ["include", "exclude"];

   log(`${label}decide: kept ${pc.bold(String(selected.length))} / ${total} in ${decideT1 - decideT0}ms`);
   log(`${label}done`);
   return selected;
}