import { hideBin } from "yargs/helpers";
import yargs from "yargs";
import pc from "picocolors";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { appendStubIfNoExt, loadConfig, loadListFile, readIgnoreFiles } from "./config.js";
// add imports near top
import { getAllPresets } from "./presets.js";
import { saveUserPreset, removeUserPreset, loadUserPresets } from "./user-presets.js";
import YAML from "yaml";
import { getBuiltinStubDir, getGlobalStubDirs } from "./utils.js";
import { handlePack } from "./handle-pack.js";
import picomatch from "picomatch";
import { buildGroupZipMapper } from "./groups.js";
import { buildFileList } from "./pack";
/* ------------------------------- tiny helpers ------------------------------- */
// 1) Extract the handler so both commands reuse it

///===
async function fileExists(p: string) {
   try { await fs.access(p); return true; } catch { return false; }
}

async function readDirSafe(dir: string) {
   try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}



function fmtRel(base: string, file: string) {
   const rel = path.relative(process.cwd(), path.join(base, file)) || file;
   return rel.replaceAll("\\", "/");
}

/** Minimal arrow-key selector without extra deps */
async function arrowSelectPrompt(title: string, items: string[]): Promise<number> {
   if (!items.length) {
      console.error(pc.red("No items to select."));
      process.exit(2);
   }
   const stdin = process.stdin;
   const stdout = process.stdout;

   function render(idx: number, initial = false) {
      if (!initial) stdout.write(`\x1b[${items.length + 2}A`);
      stdout.write(pc.bold(title) + "\n");
      stdout.write(pc.dim("Use ↑/↓ and Enter") + "\n");
      for (let i = 0; i < items.length; i++) {
         const line = (i === idx ? pc.cyan("> ") : "  ") + items[i];
         stdout.write(line + "\n");
      }
   }

   return new Promise<number>((resolve) => {
      let index = 0;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf8");

      render(index, true);

      function onData(key: string) {
         if (key === "\u0003") { // Ctrl-C
            cleanup();
            process.exit(130);
         }
         if (key === "\r" || key === "\n") { // Enter
            cleanup();
            resolve(index);
            return;
         }
         if (key === "\u001b[A") { // up
            index = (index - 1 + items.length) % items.length;
            render(index);
         } else if (key === "\u001b[B") { // down
            index = (index + 1) % items.length;
            render(index);
         }
      }

      function cleanup() {
         stdin.off("data", onData);
         if (stdin.isTTY) stdin.setRawMode?.(false);
         stdin.pause();
         process.stdout.write("\n");
      }

      stdin.on("data", onData);
   });
}

/** Multi-select prompt (no deps): returns indices of selected items */
async function multiSelectPrompt(title: string, items: string[], preChecked: boolean[] = []): Promise<number[]> {
   if (!items.length) {
      console.error("No items to select.");
      process.exit(2);
   }
   const stdin = process.stdin;
   const stdout = process.stdout;

   let cursor = 0;
   const checked = items.map((_, i) => !!preChecked[i]);

   function render(initial = false) {
      if (!initial) stdout.write(`\x1b[${items.length + 3}A`);
      stdout.write(pc.bold(title) + "\n");
      stdout.write(pc.dim("Use ↑/↓, space to toggle, 'a' = toggle all, Enter to confirm") + "\n");
      for (let i = 0; i < items.length; i++) {
         const isCur = i === cursor;
         const mark = checked[i] ? "[x]" : "[ ]";
         const prefix = isCur ? pc.cyan("> ") : "  ";
         stdout.write(`${prefix}${mark} ${items[i]}\n`);
      }
      const summary = `${checked.filter(Boolean).length}/${items.length} selected`;
      stdout.write(pc.dim(summary) + "\n");
   }

   return new Promise<number[]>((resolve) => {
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      render(true);

      function onData(key: string) {
         if (key === "\u0003") { cleanup(); process.exit(130); }         // Ctrl-C
         else if (key === "\r" || key === "\n") {                         // Enter
            const out = checked.map((v, i) => v ? i : -1).filter(i => i >= 0);
            cleanup(); resolve(out);
         }
         else if (key === " ") { checked[cursor] = !checked[cursor]; render(); } // Space
         else if (key === "a" || key === "A") {
            const allOn = checked.every(Boolean);
            for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
            render();
         }
         else if (key === "\u001b[A") { cursor = (cursor - 1 + items.length) % items.length; render(); } // Up
         else if (key === "\u001b[B") { cursor = (cursor + 1) % items.length; render(); }               // Down
      }

      function cleanup() {
         stdin.off("data", onData);
         if (stdin.isTTY) stdin.setRawMode?.(false);
         stdin.pause();
         stdout.write("\n");
      }
      stdin.on("data", onData);
   });
}

/* ---------------------------- stub resolution utils ---------------------------- */

type StubCandidate = { label: string; dir: string; file: string; full: string; };

async function listStubCandidates(localDir: string, globalDirs: string[], includeGlobals: boolean): Promise<StubCandidate[]> {
   const candidates: StubCandidate[] = [];

   // Local
   const localEntries = await readDirSafe(localDir);
   for (const e of localEntries) {
      if (!e.isFile()) continue;
      if (!/\.(stub|ya?ml|json)$/i.test(e.name)) continue;
      const full = path.join(localDir, e.name);
      candidates.push({ label: `[local] ${e.name}`, dir: localDir, file: e.name, full });
   }

   if (includeGlobals) {
      for (const g of globalDirs) {
         const gEntries = await readDirSafe(g);
         for (const e of gEntries) {
            if (!e.isFile()) continue;
            if (!/\.(stub|ya?ml|json)$/i.test(e.name)) continue;
            const full = path.join(g, e.name);
            const base = path.basename(g);
            candidates.push({ label: `[global:${base}] ${e.name}`, dir: g, file: e.name, full });
         }
      }
   }

   {
      const b = getBuiltinStubDir();
      const bEntries = await readDirSafe(b);
      for (const e of bEntries) {
         if (!e.isFile()) continue;
         if (!/\.(stub|ya?ml|json)$/i.test(e.name)) continue;
         const full = path.join(b, e.name);
         candidates.push({ label: `[builtin] ${e.name}`, dir: b, file: e.name, full });
      }
   }

   // stable sort by label
   candidates.sort((a, b) => a.label.localeCompare(b.label));
   return candidates;
}


/** Try resolve a stub name:
 * - if name has no extension, try "<name>.stub" in local, then each global dir
 * - if not found, try the raw name as-is in local, then each global dir
 */
async function resolveStubPath(name: string, localDir: string, globalDirs: string[], includeGlobals: boolean): Promise<string | null> {
   const first = appendStubIfNoExt(name);

   const tryPaths: string[] = [];
   // local candidates
   tryPaths.push(path.join(localDir, first));
   tryPaths.push(path.join(localDir, name));

   if (includeGlobals) {
      for (const g of globalDirs) {
         tryPaths.push(path.join(g, first));
         tryPaths.push(path.join(g, name));
      }
   }

   {
      for (const g of globalDirs) {
         tryPaths.push(path.join(g, first), path.join(g, name));
      }
   }

   for (const p of tryPaths) {
      if (await fileExists(p)) return p;
   }
   return null;
}

/* ----------------------------------- CLI ---------------------------------- */

await yargs(hideBin(process.argv))
   .scriptName("zipper")
   /* -------------------------------- pack --------------------------------- */
   // 2) Register both commands (build is an alias/hidden)
   .command(
      "pack",
      "Create a zip using .zipconfig / zip.json",
      y => y
         .option("config", { type: "string", desc: "Path to config file (no extension assumes .stub)" })
         .option("out", { type: "string", desc: "Output zip path (overrides config)" })
         .option("include", { type: "array", desc: "Additional include globs" })
         .option("exclude", { type: "array", desc: "Additional exclude globs" })
         .option("order", { type: "string", choices: ["include,exclude", "exclude,include"] as const, desc: "Rule order" })
         .option("root", { type: "string", desc: "Project root for scanning" })
         .option("dry-run", { type: "boolean", default: false, desc: "Print final file list and exit" })
         .option("respect-gitignore", { type: "boolean", default: undefined, desc: "Also exclude files from .gitignore" })
         .option("from", { type: "string", desc: "Read additional paths (one per line) from this file" })
         .option("ignore-file", { type: "array", desc: "Additional ignore files (.zipignore by default)" })
         .option("no-manifest", { type: "boolean", desc: "Disable manifest emission" })
         .option("group", { type: "array", desc: "Only include these group(s) (by name). Others are ignored." })
         // cli.ts (pack builder additions)
         .option("preprocess", {
            type: "array",
            desc: "Additional preprocess module(s) (.js/.ts) to load (in addition to config)",
         })
         .option("list", { type: "boolean", default: false, desc: "Print final zip paths (after groups+preprocess) and exit" })

         .option("no-preprocess", { type: "boolean", default: false, desc: "Disable preprocess pipeline" })
         .option("strict-preprocess", { type: "boolean", default: false, desc: "Fail on preprocess errors" })
         .option("preprocess-timeout", { type: "number", desc: "Per-file preprocess timeout (ms)" })
         .option("preprocess-max-bytes", { type: "number", desc: "Skip preprocess for files bigger than this" })
         .option("no-hooks", { type: "boolean", default: false, desc: "Disable pre/post hooks" })
         .option("pre", { type: "array", desc: "Append extra pre-hook commands" })
         .option("post", { type: "array", desc: "Append extra post-hook commands" })
         .option("hook-timeout", { type: "number", desc: "Default timeout for hooks in ms (per command)" })
         .option("hooks-dry-run", { type: "boolean", default: false, desc: "Print hooks without executing" })
         .option("preprocess-binary-mode", { type: "string", choices: ["skip", "pass", "buffer"] as const }),
      handlePack
   )
   .command(
      "build",
      false, // hidden alias
      y => y
         .option("config", { type: "string" })
         .option("out", { type: "string" })
         .option("include", { type: "array" })
         .option("exclude", { type: "array" })
         .option("order", { type: "string", choices: ["include,exclude", "exclude,include"] as const })
         .option("root", { type: "string" })
         .option("dry-run", { type: "boolean", default: false })
         .option("respect-gitignore", { type: "boolean", default: undefined })
         .option("from", { type: "string" })
         .option("ignore-file", { type: "array" })
         .option("no-manifest", { type: "boolean" })
         // cli.ts (pack builder additions)
         .option("preprocess", {
            type: "array",
            desc: "Additional preprocess module(s) (.js/.ts) to load (in addition to config)",
         })
         .option("list", { type: "boolean", default: false, desc: "Print final zip paths (after groups+preprocess) and exit" })
         .option("group", { type: "array", desc: "Only include these group(s) (by name). Others are ignored." })
         .option("no-preprocess", { type: "boolean", default: false, desc: "Disable preprocess pipeline" })
         .option("strict-preprocess", { type: "boolean", default: false, desc: "Fail on preprocess errors" })
         .option("preprocess-timeout", { type: "number", desc: "Per-file preprocess timeout (ms)" })
         .option("preprocess-max-bytes", { type: "number", desc: "Skip preprocess for files bigger than this" })
         .option("no-hooks", { type: "boolean", default: false, desc: "Disable pre/post hooks" })
         .option("pre", { type: "array", desc: "Append extra pre-hook commands" })
         .option("post", { type: "array", desc: "Append extra post-hook commands" })
         .option("hook-timeout", { type: "number", desc: "Default timeout for hooks in ms (per command)" })
         .option("hooks-dry-run", { type: "boolean", default: false, desc: "Print hooks without executing" })
         .option("preprocess-binary-mode", { type: "string", choices: ["skip", "pass", "buffer"] as const }),
      handlePack
   )

   /* -------------------------------- init --------------------------------- */
   .command("init [stub]", "Create .zipconfig from a stub", y => y
      .positional("stub", { type: "string", describe: "Stub filename or base name (e.g. inertia-prod)" })
      .option("dir", { type: "string", default: "stubs", describe: "Local directory containing stub files" })
      .option("out", { type: "string", default: ".zipconfig", describe: "Destination file" })
      .option("interactive", { type: "boolean", default: undefined, describe: "Force interactive selection" })
      .option("no-global", { type: "boolean", default: false, describe: "Disable searching global stub directories" })
      .option("global-dir", { type: "array", describe: "Additional global stub dir(s) to search (can repeat)" })
      , async (args) => {
         const localDir = path.isAbsolute(String(args.dir)) ? String(args.dir) : path.join(process.cwd(), String(args.dir));
         const globalDirs = getGlobalStubDirs((args["global-dir"] as string[] | undefined)?.map(String) ?? []);
         const includeGlobals = !args["no-global"];

         let chosen = args.stub ? String(args.stub) : "";

         // Interactive menu if no name or if forced
         if (!chosen || args.interactive) {
            const candidates = await listStubCandidates(localDir, globalDirs, includeGlobals);
            if (!candidates.length) {
               console.error(pc.red(`No stub/config files found.\nLocal: ${localDir}\nGlobals: ${includeGlobals ? globalDirs.join(", ") || "(none)" : "(disabled)"}`));
               process.exit(2);
            }
            const idx = await arrowSelectPrompt("Select a stub", candidates.map(c => `${c.label}  ${pc.dim(fmtRel(c.dir, c.file))}`));
            const picked = candidates[idx];
            const content = await fs.readFile(picked.full, "utf8");
            const outPath = path.resolve(process.cwd(), String(args.out));
            await fs.writeFile(outPath, content, "utf8");
            console.log(pc.green(`✔ Wrote ${outPath} from ${picked.full}`));
            return;
         }

         // Non-interactive: resolve name across local + global
         const resolved = await resolveStubPath(chosen, localDir, globalDirs, includeGlobals);
         if (!resolved) {
            console.error(pc.red(`Could not find stub "${chosen}".\nSearched:\n  - ${fmtRel("", localDir)}\n  - ${includeGlobals ? globalDirs.map(d => fmtRel("", d)).join("\n  - ") : "(globals disabled)"}`));
            process.exit(2);
         }

         const content = await fs.readFile(resolved, "utf8");
         const outPath = path.resolve(process.cwd(), String(args.out));
         await fs.writeFile(outPath, content, "utf8");
         console.log(pc.green(`✔ Wrote ${outPath} from ${resolved}`));
      })

   /* ============================ preset (group) ============================ */
   .command(
      "preset",
      "Manage presets",
      (yy) => yy
         // preset ls
         .command("ls", "List available presets (built-in and user)", y => y
            .option("search", { type: "string", describe: "Filter by substring (case-insensitive)" })
            .option("dirs", { type: "array", describe: "Extra user preset dir(s) to search (repeatable)" })
            , async (args) => {
               const all = await getAllPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
               const user = await loadUserPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
               const q = (args.search ? String(args.search).toLowerCase() : "");
               const names = Object.keys(all).sort().filter(n => q ? n.toLowerCase().includes(q) : true);
               if (!names.length) { console.log("(no presets found)"); return; }
               for (const n of names) console.log(`${n}${user[n] ? " [user]" : ""}`);
            })

         // preset show
         .command("show <name>", "Show a preset", y => y
            .positional("name", { type: "string", demandOption: true })
            .option("format", { type: "string", choices: ["json", "yaml"], default: "json" })
            .option("pretty", { type: "boolean", default: true })
            .option("dirs", { type: "array", describe: "Extra user preset dir(s)" })
            , async (args) => {
               const all = await getAllPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
               const p = all[String(args.name)];
               if (!p) { console.error(`Preset not found: ${args.name}`); process.exit(2); }
               const out = { name: args.name, ...p };
               console.log(String(args.format) === "yaml" ? YAML.stringify(out)
                  : JSON.stringify(out, null, args.pretty ? 2 : 0));
            })

         // preset add
         .command("add <name>", "Create/update a user preset", y => y
            .positional("name", { type: "string", demandOption: true, describe: "Preset name (e.g. my-company.laravel)" })
            .option("from", { type: "string", describe: "Read include/exclude from a .zipconfig / stub / yaml / json" })
            .option("include", { type: "array", describe: "Add include globs (repeatable)" })
            .option("exclude", { type: "array", describe: "Add exclude globs (repeatable)" })
            .option("dir", { type: "string", describe: "Directory to save the preset (defaults to ~/.config/zipper/presets)" })
            , async (args) => {
               const name = String(args.name);
               let preset: any = { include: [], exclude: [] };

               if (args.from) {
                  const fp = String(args.from);
                  const raw = await fs.readFile(fp, "utf8");
                  let src: any; try { src = fp.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw); }
                  catch { console.error("Failed to parse --from file."); process.exit(2); }
                  const cfg = src?.zipper ?? src ?? {};
                  if (Array.isArray(cfg.include)) preset.include.push(...cfg.include);
                  if (Array.isArray(cfg.exclude)) preset.exclude.push(...cfg.exclude);
               }
               if (args.include?.length) preset.include.push(...(args.include as string[]));
               if (args.exclude?.length) preset.exclude.push(...(args.exclude as string[]));

               preset.include = Array.from(new Set(preset.include || []));
               preset.exclude = Array.from(new Set(preset.exclude || []));

               try {
                  const saved = await saveUserPreset(name, preset, args.dir ? String(args.dir) : undefined);
                  console.log(`✔ Saved user preset "${name}" at ${saved}`);
               } catch (e) {
                  console.error(`Failed to save preset: ${(e as Error).message}`); process.exit(2);
               }
            })

         // preset rm
         .command("rm <name>", "Remove a user preset", y => y
            .positional("name", { type: "string", demandOption: true })
            .option("dirs", { type: "array", describe: "Extra user preset dir(s)" })
            , async (args) => {
               const ok = await removeUserPreset(String(args.name), (args.dirs as string[] | undefined)?.map(String) ?? []);
               if (!ok) { console.error("Preset not found."); process.exit(2); }
               console.log("✔ Removed preset");
            })

         // preset export
         .command("export <name>", "Export a preset to a file", y => y
            .positional("name", { type: "string", demandOption: true })
            .option("to", { type: "string", describe: "Output path (default: ./<name>.yml)" })
            .option("format", { type: "string", choices: ["auto", "yaml", "json"], default: "auto" })
            .option("pretty", { type: "boolean", default: true })
            .option("dirs", { type: "array", describe: "Extra user preset dir(s)" })
            , async (args) => {
               const name = String(args.name);
               const all = await getAllPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
               const preset = all[name];
               if (!preset) { console.error(`Preset not found: ${name}`); process.exit(2); }
               let outPath = args.to ? String(args.to) : `./${name}.yml`;
               const ext = outPath.toLowerCase().endsWith(".json") ? "json"
                  : outPath.toLowerCase().match(/\.ya?ml$/) ? "yaml"
                     : (args.format as string);
               const data = { name, ...preset };
               const content = ext === "json" ? JSON.stringify(data, null, args.pretty ? 2 : 0)
                  : YAML.stringify(data);
               if (ext === "json" && !outPath.endsWith(".json")) outPath += ".json";
               if (ext !== "json" && !outPath.match(/\.ya?ml$/i)) outPath += ".yml";
               await (await import("node:fs/promises")).writeFile(outPath, content, "utf8");
               console.log(`✔ Exported preset "${name}" to ${outPath}`);
            })

         // preset import
         .command("import <name>", "Create/update a user preset from a config/stub file", y => y
            .positional("name", { type: "string", demandOption: true })
            .option("from", { type: "string", demandOption: true, describe: "Path to .zipconfig / stub / yaml / json" })
            .option("dir", { type: "string", describe: "Destination user preset directory" })
            , async (args) => {
               const fp = String(args.from);
               const raw = await (await import("node:fs/promises")).readFile(fp, "utf8");
               let src: any; try { src = fp.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw); }
               catch { console.error("Failed to parse --from file."); process.exit(2); }
               const cfg = src?.zipper ?? src ?? {};
               const preset = {
                  include: Array.isArray(cfg.include) ? Array.from(new Set(cfg.include)) : [],
                  exclude: Array.isArray(cfg.exclude) ? Array.from(new Set(cfg.exclude)) : []
               };
               try {
                  const saved = await saveUserPreset(String(args.name), preset as any, args.dir ? String(args.dir) : undefined);
                  console.log(`✔ Imported preset "${args.name}" from ${fp}\n  → ${saved}`);
               } catch (e) {
                  console.error(`Failed to import preset: ${(e as Error).message})
               } `); process.exit(2);
               }
            })

         // preset rename
         .command("rename <old> <new>", "Rename a user preset", y => y
            .positional("old", { type: "string", demandOption: true })
            .positional("new", { type: "string", demandOption: true })
            .option("dirs", { type: "array", describe: "Extra user preset dir(s)" })
            .option("dir", { type: "string", describe: "Destination directory to save the renamed preset" })
            , async (args) => {
               const userMap = await loadUserPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
               const payload = userMap[String(args.old)];
               if (!payload) { console.error(`User preset not found: ${args.old} `); process.exit(2); }
               try {
                  const saved = await saveUserPreset(String(args.new), payload, args.dir ? String(args.dir) : undefined);
                  await removeUserPreset(String(args.old), (args.dirs as string[] | undefined)?.map(String) ?? []);
                  console.log(`✔ Renamed "${args.old}" → "${args.new}"\n  → ${saved} `);
               } catch (e) {
                  console.error(`Failed to rename: ${(e as Error).message} `); process.exit(2);
               }
            })

         // preset migrate (your interactive implementation)
         .command("migrate", "Bulk-import presets from stub/config files", y => y
            .option("all", { type: "boolean", default: false, describe: "Migrate all files in from-dir (non-interactive)" })
            .option("from-dir", { type: "string", default: "stubs", describe: "Directory to scan for stubs/configs" })
            .option("include-globals", { type: "boolean", default: false, describe: "Also scan global stub directories" })
            .option("global-dir", { type: "array", describe: "Extra global stub dir(s) to include" })
            .option("dir", { type: "string", describe: "Destination user preset directory" })
            .option("dry-run", { type: "boolean", default: false })
            .option("interactive", { type: "boolean", default: undefined, describe: "Force interactive multi-select" })
            , async (args) => {
               // inside the grouped yargs.command("preset", ...).command("migrate", ..., async (args) => {
               const localDir = path.isAbsolute(String(args["from-dir"])) ? String(args["from-dir"])
                  : path.join(process.cwd(), String(args["from-dir"]));
               const extras = (args["global-dir"] as string[] | undefined)?.map(String) ?? [];

               // list candidates helper
               async function list(dir: string): Promise<string[]> {
                  try {
                     const ents = await fs.readdir(dir, { withFileTypes: true });
                     return ents
                        .filter(e => e.isFile())
                        .map(e => path.join(dir, e.name))
                        .filter(full => /\.(stub|ya?ml|json)$/i.test(full));
                  } catch { return []; }
               }

               // gather candidates: local + (optional) globals
               const candidates = new Set<string>([...await list(localDir)]);
               if (args["include-globals"]) {
                  const globalDirs = getGlobalStubDirs(extras);
                  for (const g of globalDirs) for (const f of await list(g)) candidates.add(f);
               }
               if (!candidates.size) {
                  console.error(pc.red("No stub/config files found to migrate."));
                  process.exit(2);
               }

               const files = Array.from(candidates).sort((a, b) => a.localeCompare(b));
               const labels = files.map(f => {
                  const base = path.basename(f);
                  const dir = path.dirname(f);
                  const tag = dir.includes(".config/zipper/stubs") || dir.endsWith(".zipper/stubs") ? "global"
                     : (dir.endsWith("/stubs") || dir.endsWith("\\stubs")) ? "local" : "other";
                  return `[${tag}] ${base}  ${pc.dim(path.relative(process.cwd(), dir) || ".")}`;
               });

               let selected: number[];
               const doInteractive = args.interactive ?? !args.all;

               // ✅ use multiSelectPrompt again
               if (doInteractive && process.stdin.isTTY) {
                  const pre = files.map(() => !!args.all); // precheck if --all
                  selected = await multiSelectPrompt("Select files to migrate into user presets", labels, pre);
                  if (!selected.length) { console.log("(nothing selected)"); return; }
               } else {
                  // non-interactive (CI) or --all: select all
                  selected = files.map((_, i) => i);
               }

               const toImport = selected.map(i => files[i]);
               const destDir = args.dir ? String(args.dir) : undefined;

               let migrated = 0;
               for (const file of toImport) {
                  const raw = await fs.readFile(file, "utf8");
                  let data: any;
                  try { data = file.toLowerCase().endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw); }
                  catch { console.warn(`Skipping (parse error): ${file}`); continue; }

                  const cfg = data?.zipper ?? data ?? {};
                  const include = Array.isArray(cfg.include) ? Array.from(new Set(cfg.include)) : [];
                  const exclude = Array.isArray(cfg.exclude) ? Array.from(new Set(cfg.exclude)) : [];
                  const name = path.basename(file).replace(/\.(stub|ya?ml|json)$/i, "");

                  if (args["dry-run"]) { console.log(`would import: ${name}  ←  ${file}`); continue; }

                  try {
                     //@ts-ignore
                     const saved = await saveUserPreset(name, { include, exclude }, destDir);
                     console.log(`✔ imported: ${name}  ←  ${file}\n  → ${saved}`);
                     migrated++;
                  } catch (e) {
                     console.warn(`Failed to import ${name}: ${(e as Error).message}`);
                  }
               }

               if (!args["dry-run"]) console.log(`\nDone. Migrated ${migrated} preset(s).`);
            })

         .demandCommand(1, "Specify a preset subcommand.")
         .strict()
   )

   /* ============================= stub (group) ============================== */
   .command(
      "stub",
      "Manage stubs",
      (yy) => yy
         // stub ls
         .command("ls", "List local/global/builtin stub files", y => y
            .option("dir", { type: "string", default: "stubs", describe: "Local stubs dir" })
            .option("global-dir", { type: "array", describe: "Extra global stubs dir(s)" })
            .option("no-global", { type: "boolean", default: false, describe: "Disable global dirs" })
            , async (args) => {
               const local = path.isAbsolute(String(args.dir)) ? String(args.dir) : path.join(process.cwd(), String(args.dir));
               const globals = args["no-global"] ? [] : getGlobalStubDirs((args["global-dir"] as string[] | undefined)?.map(String) ?? []);
               const builtin = getBuiltinStubDir();

               async function ls(dir: string) {
                  try {
                     const entries = await fs.readdir(dir, { withFileTypes: true });
                     return entries.filter(e => e.isFile()).map(e => e.name).filter(n => /\.(stub|ya?ml|json)$/i.test(n));
                  } catch { return []; }
               }

               const show = async (label: string, dir: string) => {
                  const list = await ls(dir);
                  console.log(list.length ? `[${label}] ${dir}` : `[${label}] ${dir} (empty)`);
                  for (const n of list) console.log("  " + n);
               };

               await show("local", local);
               for (const g of globals) await show("global", g);
               await show("builtin", builtin);
            })

         // stub add
         .command("add <file>", "Copy a stub file into your global stubs directory", y => y
            .positional("file", { type: "string", demandOption: true })
            .option("to", { type: "string", describe: "Target directory for global stubs (default: ~/.config/zipper/stubs)" })
            , async (args) => {
               const src = path.resolve(String(args.file));
               const content = await fs.readFile(src, "utf8");
               const home = os.homedir();
               const targetDir = args.to ? path.resolve(String(args.to))
                  : path.join(home, ".config", "zipper", "stubs");
               await fs.mkdir(targetDir, { recursive: true });
               const dst = path.join(targetDir, path.basename(src));
               await fs.writeFile(dst, content, "utf8");
               console.log(`✔ Copied to ${dst}`);
            })

         /* ------------------------------- stub cp -------------------------------- */
         .command("cp <name> <dest>", "Copy a stub/config file to a destination path", y => y
            .positional("name", { type: "string", demandOption: true, describe: "Stub base name or filename (e.g. laravel or inertia-prod.stub)" })
            .positional("dest", { type: "string", demandOption: true, describe: "Destination file OR directory" })
            .option("dir", { type: "string", default: "stubs", describe: "Local stubs directory to search first" })
            .option("global-dir", { type: "array", describe: "Additional global stub dir(s) to search (repeatable)" })
            .option("no-global", { type: "boolean", default: false, describe: "Disable searching global stub directories" })
            .option("force", { type: "boolean", default: false, describe: "Overwrite if the destination file exists" })
            , async (args) => {
               const name = String(args.name);
               const destArg = String(args.dest);
               const local = path.isAbsolute(String(args.dir)) ? String(args.dir) : path.join(process.cwd(), String(args.dir));
               const globals = !args["no-global"] ? getGlobalStubDirs((args["global-dir"] as string[] | undefined)?.map(String) ?? []) : [];

               // 1) Resolve source (allow direct path or by name; built-ins are always searched by resolveStubPath)
               const direct = path.isAbsolute(name) ? name : path.resolve(process.cwd(), name);
               let srcPath: string | null = null;
               if (await fileExists(direct)) {
                  srcPath = direct;
               } else {
                  srcPath = await resolveStubPath(name, local, globals, true);
               }
               if (!srcPath) {
                  console.error(pc.red(
                     `Could not find stub "${name}".
Searched:
  - ${local}
  - ${globals.length ? globals.join("\n  - ") : "(no global dirs)"}
  - ${getBuiltinStubDir()}  (built-in)`));
                  process.exit(2);
               }

               // 2) Compute destination path (file or directory)
               let destPath = path.isAbsolute(destArg) ? destArg : path.resolve(process.cwd(), destArg);

               // If dest is an existing directory, copy into it using the source basename
               async function isDir(p: string) {
                  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
               }
               if (await isDir(destPath)) {
                  destPath = path.join(destPath, path.basename(srcPath));
               }

               // If parent directory doesn't exist, create it
               await fs.mkdir(path.dirname(destPath), { recursive: true });

               // 3) Respect --force
               async function pathExists(p: string) { try { await fs.access(p); return true; } catch { return false; } }
               if (await pathExists(destPath) && !args.force) {
                  console.error(pc.red(`Destination exists: ${destPath}\nUse --force to overwrite.`));
                  process.exit(2);
               }

               // 4) Copy
               await fs.copyFile(srcPath, destPath);
               console.log(pc.green(`✔ Copied ${srcPath} → ${destPath}`));
            })

         // stub cat
         /* -------------------------------- stub cat -------------------------------- */
         .command("cat [name]", "Print a stub/config file to stdout", y => y
            .positional("name", { type: "string", describe: "Stub base name or filename (e.g. laravel or inertia-prod.stub)" })
            .option("dir", { type: "string", default: "stubs", describe: "Local stubs directory to search first" })
            .option("global-dir", { type: "array", describe: "Additional global stub dir(s) to search (repeatable)" })
            .option("no-global", { type: "boolean", default: false, describe: "Disable searching global stub directories" })
            .option("interactive", { type: "boolean", default: undefined, describe: "Force interactive selection when a name is provided" })
            , async (args) => {
               const maybeName = args.name ? String(args.name) : "";
               const localDir = path.isAbsolute(String(args.dir)) ? String(args.dir) : path.join(process.cwd(), String(args.dir));
               const includeGlobals = !args["no-global"];
               const globals = includeGlobals ? getGlobalStubDirs((args["global-dir"] as string[] | undefined)?.map(String) ?? []) : [];

               // If no name OR interactive is forced → show picker (single-select)
               if (!maybeName || args.interactive) {
                  const candidates = await listStubCandidates(localDir, globals, includeGlobals);
                  if (!candidates.length) {
                     console.error(pc.red("No stub/config files found (looked in local, global, built-in)."));
                     process.exit(2);
                  }
                  const idx = await arrowSelectPrompt(
                     "Select a stub to print",
                     candidates.map(c => `${c.label}  ${pc.dim(path.relative(process.cwd(), c.dir) || ".")}`)
                  );
                  const picked = candidates[idx];
                  const content = await fs.readFile(picked.full, "utf8");
                  process.stdout.write(content);
                  return;
               }

               // Direct path support (absolute or relative file)
               const direct = path.isAbsolute(maybeName) ? maybeName : path.resolve(process.cwd(), maybeName);
               if (await fileExists(direct)) {
                  const content = await fs.readFile(direct, "utf8");
                  process.stdout.write(content);
                  return;
               }

               // Resolve by name across local → global → built-in
               const resolved = await resolveStubPath(maybeName, localDir, globals, includeGlobals);
               if (!resolved) {
                  console.error(pc.red(
                     `Could not find stub "${maybeName}".
Searched:
  - ${localDir}
  - ${includeGlobals ? (globals.length ? globals.join("\n  - ") : "(no global dirs)") : "(globals disabled)"}
  - ${getBuiltinStubDir()}  (built-in)`
                  ));
                  process.exit(2);
               }

               const content = await fs.readFile(resolved, "utf8");
               process.stdout.write(content);
            })

         .demandCommand(1, "Specify a stub subcommand.")
         .strict()
   )

   /* =========================== preprocess (group) =========================== */
   .command(
      "preprocess",
      "Preprocessor utilities",
      (yy) => yy
         .command("doctor", "Validate preprocess modules and run a small test set", y => y
            .option("config", { type: "string", desc: "Config path or stub name (YAML/JSON/stub only)" })
            .option("preprocess", { type: "array", desc: "Extra preprocess module(s) (.js/.ts) to load in addition to config" })
            .option("sample", { type: "string", desc: "Specific file to run through preprocess (absolute or relative)" })
            .option("glob", { type: "array", desc: "Glob(s) to select sample files (repeatable)" })
            .option("limit", { type: "number", default: 10, desc: "Max number of files to test" })
            .option("strict-preprocess", { type: "boolean", default: false, desc: "Fail on handler errors/timeouts" })
            .option("preprocess-timeout", { type: "number", desc: "Override per-file timeout (ms)" })
            .option("preprocess-max-bytes", { type: "number", desc: "Skip preprocess for files bigger than this" })
            .option("preprocess-binary-mode", { type: "string", choices: ["skip", "pass", "buffer"] as const, desc: "Binary file behavior" })
            .option("verbose", { type: "boolean", default: false, desc: "Print extra details" })
            , async (args) => {
               const { loadConfig, loadListFile, readIgnoreFiles, loadPreprocessHandlers } = await import("./config");
               const { buildFileList } = await import("./pack");
               const { runPreprocessPipeline } = await import("./preprocess");

               // 1) Load main config (YAML/JSON/stub only; JS/TS are for modules)
               const { cfg, filepath } = await loadConfig(args.config as string | undefined);

               // 2) CLI overrides for preprocess behavior
               cfg.preprocess = cfg.preprocess ?? {};
               if (typeof args["preprocess-timeout"] === "number") cfg.preprocess.timeoutMs = Number(args["preprocess-timeout"]);
               if (typeof args["preprocess-max-bytes"] === "number") cfg.preprocess.maxBytes = Number(args["preprocess-max-bytes"]);
               if (typeof args["preprocess-binary-mode"] === "string") cfg.preprocess.binaryMode = String(args["preprocess-binary-mode"]) as any;

               const root = path.resolve(process.cwd(), cfg.root ?? ".");
               const strict = !!args["strict-preprocess"];

               // 3) Load preprocess handlers from config modules + CLI modules
               const extraMods = (args["preprocess"] as string[] | undefined)?.map(String) ?? [];
               const handlers = await loadPreprocessHandlers(cfg, root, extraMods);
               cfg.preprocess.handlers = [...(cfg.preprocess.handlers ?? []), ...handlers];

               if (!cfg.preprocess.handlers?.length) {
                  console.error(pc.red("No preprocess handlers found. Add them under `preprocess.modules` in your .zipconfig or pass --preprocess <file>."));
                  process.exit(2);
               }

               console.log(pc.dim(`config: ${filepath ?? "(defaults)"}`));
               if (handlers.length) console.log(pc.dim(`loaded handlers: ${handlers.length} (from modules + inline)`));

               // 4) Collect sample files
               const sampleSet: string[] = [];

               // 4a) explicit --sample
               if (args.sample) {
                  const s = String(args.sample);
                  const abs = path.isAbsolute(s) ? s : path.join(root, s);
                  try {
                     await fs.stat(abs);
                     sampleSet.push(abs);
                  } catch {
                     console.error(pc.red(`Sample not found: ${s}`));
                     process.exit(2);
                  }
               }

               // 4b) from --glob (respect root)
               const globs = (args.glob as string[] | undefined)?.map(String) ?? [];
               if (globs.length) {
                  // Reuse your pack file walker and inject temporary include set
                  const includeBackup = cfg.include;
                  cfg.include = globs;
                  const extraIgnore = readIgnoreFiles(root, cfg.ignoreFiles);
                  const listExtra = loadListFile(root, undefined);
                  const picks = await buildFileList(cfg, listExtra, extraIgnore);
                  for (const p of picks) sampleSet.push(path.join(root, p));
                  cfg.include = includeBackup;
               }

               // 4c) else pick a small set from normal pack selection
               if (!sampleSet.length) {
                  const extraIgnore = readIgnoreFiles(root, cfg.ignoreFiles);
                  const listExtra = loadListFile(root, undefined);
                  const all = await buildFileList(cfg, listExtra, extraIgnore);
                  for (const rel of all) sampleSet.push(path.join(root, rel));
               }

               // de-dup and limit
               const uniq = Array.from(new Set(sampleSet)).slice(0, Math.max(1, Number(args.limit) || 10));
               if (!uniq.length) {
                  console.error(pc.red("No files available to test."));
                  process.exit(2);
               }

               console.log(pc.dim(`testing ${uniq.length} file(s)`));

               // 5) Run pipeline (re-using your real preprocess engine)
               try {
                  const { entries, changedCount, omittedCount } = await runPreprocessPipeline(uniq, root, cfg, { strict });

                  // 6) Pretty print results
                  const changed = new Set<string>();
                  const omitted = new Set<string>();
                  const kept = new Set<string>();

                  // Map back by zipPath/source to determine status
                  for (const src of uniq) {
                     // Find corresponding entry/entries by original relative
                     const rel = path.relative(root, src).replaceAll("\\", "/");
                     const hit = entries.find(e => e.zipPath === rel);
                     if (!hit) { omitted.add(rel); continue; }
                     if ("content" in hit) changed.add(rel);
                     else kept.add(rel);
                  }

                  const pad = (s: string, n = 9) => (s + " ".repeat(n)).slice(0, n);
                  for (const rel of omitted) console.log(`${pc.red(pad("omitted"))} ${rel}`);
                  for (const rel of changed) console.log(`${pc.yellow(pad("changed"))} ${rel}`);
                  for (const rel of kept) console.log(`${pc.green(pad("ok"))} ${rel}`);

                  console.log(
                     `\nSummary: ${pc.yellow(String(changedCount))} changed, ${pc.red(String(omittedCount))} omitted, ${pc.green(String(kept.size))} unchanged`
                  );
               } catch (e) {
                  console.error(pc.red(`preprocess doctor failed: ${(e as Error).message}`));
                  if (strict) process.exit(2);
               }
            })
         .demandCommand(1, "Specify a preprocess subcommand.")
         .strict()
   )

   /* ============================== group (UX) ============================== */
   .command(
      "group",
      "Group utilities",
      (yy) => yy
         .command("ls", "List groups and show sample matches", y => y
            .option("config", { type: "string", desc: "Config path or stub name" })
            .option("limit", { type: "number", default: 5, desc: "Max examples per group" })
            .option("glob", { type: "array", desc: "Restrict scan to these globs (repeatable)" })
            .option("verbose", { type: "boolean", default: false, desc: "Print extra details" })
            , async (args) => {
               const { cfg, filepath } = await loadConfig(args.config as string | undefined);
               const groups = cfg.groups ?? {};
               const names = Object.keys(groups);

               if (!names.length) {
                  console.log("(no groups defined)");
                  return;
               }

               const root = path.resolve(process.cwd(), cfg.root ?? ".");
               const includeBackup = cfg.include;

               // Optional scan limiter
               const globs = (args.glob as string[] | undefined)?.map(String) ?? [];
               if (globs.length) cfg.include = globs;

               const listExtra = loadListFile(root, undefined);
               const extraIgnore = readIgnoreFiles(root, cfg.ignoreFiles);
               const relFiles = await buildFileList(cfg, listExtra, extraIgnore);

               // restore include
               cfg.include = includeBackup;

               // Precompile include/exclude for counts + merge explicit files
               const globFilters = (args.glob as string[] | undefined)?.map(p => picomatch(p, { dot: true })) ?? null;
               const passesUserGlob = (rel: string) => !globFilters || globFilters.some(m => m(rel));

               const compiled = names.map(n => {
                  const g = groups[n];

                  // group include/exclude for CLAIM (not selection)
                  const inc = (g.include ?? []).map(p => picomatch(p, { dot: true }));
                  const exc = (g.exclude ?? []).map(p => picomatch(p, { dot: true }));

                  // matches from scanner via group globs
                  const globMatches = relFiles.filter(r => inc.some(m => m(r)) && !exc.some(m => m(r)));

                  // explicit files (exact paths), normalized; include even if not in relFiles
                  const explicitSet = new Set<string>((g.files ?? []).map(s =>
                     s.replaceAll("\\", "/").replace(/^\.?\//, "")
                  ));
                  const explicit = Array.from(explicitSet)
                     .filter(passesUserGlob);

                  // union + stable sort
                  const matches = Array.from(new Set<string>([...globMatches, ...explicit]))
                     .sort((a, b) => a.localeCompare(b));

                  return { name: n, target: g.target, priority: g.priority ?? 0, matches };
               });

               // Pretty print
               console.log(pc.dim(`config: ${filepath ?? "(defaults)"}  root: ${cfg.root ?? "."}`));
               const { map } = buildGroupZipMapper(cfg);

               for (const g of compiled.sort((a, b) => (b.priority - a.priority) || a.name.localeCompare(b.name))) {
                  console.log(pc.bold(`${g.name}`) + pc.dim(`  → ${g.target || "(root)"}  [priority ${g.priority}]  (${g.matches.length} files)`));
                  const ex = g.matches.slice(0, Math.max(1, Number(args.limit) || 5));
                  for (const rel of ex) {
                     const mapped = map(rel);
                     const tag = mapped !== rel ? "→" : " ";
                     console.log(`  ${pc.dim(rel)} ${tag} ${mapped}`);
                  }
                  if (g.matches.length > ex.length) {
                     console.log(pc.dim(`  … +${g.matches.length - ex.length} more`));
                  }
               }

               // Files matched by no group (optional extra line)
               if (args.verbose) {
                  const allMatched = new Set(compiled.flatMap(c => c.matches));
                  const unmatched = relFiles.filter(r => !allMatched.has(r));
                  console.log(pc.dim(`\nUnmatched (kept at original path): ${unmatched.length}`));
               }
            })
         .demandCommand(1, "Specify a group subcommand.")
         .strict()
   )

   .demandCommand(1)
   .help()
   .strict()
   .parse();