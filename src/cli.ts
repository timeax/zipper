#!/usr/bin/env node
import { hideBin } from "yargs/helpers";
import yargs from "yargs";
import pc from "picocolors";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { loadConfig, loadListFile, readIgnoreFiles, appendStubIfNoExt } from "./config.js";
import { buildFileList, writeZip } from "./pack.js";
import type { Order } from "./types.js";
// add imports near top
import { PRESETS, getAllPresets } from "./presets.js";
import { saveUserPreset, removeUserPreset, loadUserPresets, getPresetDirs, ensureUserPresetDir } from "./user-presets.js";
import YAML from "yaml";
import { getGlobalStubDirs } from "./utils.js";
/* ------------------------------- tiny helpers ------------------------------- */

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

   for (const p of tryPaths) {
      if (await fileExists(p)) return p;
   }
   return null;
}

/* ----------------------------------- CLI ---------------------------------- */

await yargs(hideBin(process.argv))
   .scriptName("zipper")
   /* ------------------------------- preset ls ------------------------------- */
   .command("preset ls", "List available presets", y => y
      .option("search", { type: "string", describe: "Filter by substring (case-insensitive)" })
      , async (args) => {
         const all = Object.keys(PRESETS).sort();
         const q = (args.search ? String(args.search).toLowerCase() : "");
         const list = q ? all.filter(n => n.toLowerCase().includes(q)) : all;

         if (!list.length) {
            console.log("(no presets found)");
            return;
         }
         for (const n of list) console.log(n);
      })

   /* ----------------------------- preset show <name> ----------------------------- */
   .command("preset show <name>", "Show a preset’s include/exclude rules", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("format", { type: "string", choices: ["json", "yaml"], default: "json", describe: "Output format" })
      .option("pretty", { type: "boolean", default: true, describe: "Pretty-print JSON" })
      , async (args) => {
         const name = String(args.name);
         const p = PRESETS[name];
         if (!p) {
            console.error(`Preset "${name}" not found. Try: zipper preset ls`);
            process.exit(2);
         }

         // Only include meaningful fields
         const out = {
            name,
            ...p,
         };

         const fmt = String(args.format);
         if (fmt === "yaml") {
            console.log(YAML.stringify(out));
         } else {
            console.log(JSON.stringify(out, null, args.pretty ? 2 : 0));
         }
      })
   /* -------------------------------- pack --------------------------------- */
   .command("pack", "Create a zip using .zipconfig / zip.json", y => y
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
      .option("manifest-path", { type: "string", desc: "External manifest write path" })
      , async (args) => {
         const { cfg, filepath } = await loadConfig(args.config as string | undefined);

         if (args.out) cfg.out = String(args.out);
         if (args.root) cfg.root = String(args.root);
         if (args.include?.length) cfg.include = [...(cfg.include ?? []), ...args.include.map(String)];
         if (args.exclude?.length) cfg.exclude = [...(cfg.exclude ?? []), ...args.exclude.map(String)];
         if (args.order) cfg.order = args.order.split(",") as Order;
         if (typeof args["respect-gitignore"] === "boolean") cfg.respectGitignore = args["respect-gitignore"];
         if (args["ignore-file"]?.length) cfg.ignoreFiles = [...(cfg.ignoreFiles ?? []), ...args["ignore-file"].map(String)];
         if (args["no-manifest"]) cfg.manifest = false;
         if (args["manifest-path"]) cfg.manifestPath = String(args["manifest-path"]);

         const root = path.resolve(process.cwd(), cfg.root ?? ".");
         const listExtra = loadListFile(root, args.from as string | undefined);
         const extraIgnore = readIgnoreFiles(root, cfg.ignoreFiles);

         const files = await buildFileList(cfg, listExtra, extraIgnore);

         if (args["dry-run"]) {
            console.log(pc.dim(`# Config: ${filepath ?? "(defaults)"}  Root: ${cfg.root}`));
            files.forEach(f => console.log(f));
            console.log(pc.green(`\n${files.length} files selected.`));
            return;
         }

         if (!files.length) {
            console.error(pc.red("No files matched your rules. Nothing to zip."));
            process.exit(2);
         }

         const out = await writeZip(cfg, files);
         console.log(pc.green(`✔ wrote ${out} (${files.length} files)`));
      })

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

   /* ------------------------------- preset ls -------------------------------- */
   .command("preset ls", "List available presets (built-in and user)", y => y
      .option("search", { type: "string", describe: "Filter by substring (case-insensitive)" })
      .option("dirs", { type: "array", describe: "Extra user preset dir(s) to search (repeatable)" })
      , async (args) => {
         const all = await getAllPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
         const user = await loadUserPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
         const q = (args.search ? String(args.search).toLowerCase() : "");
         const names = Object.keys(all).sort().filter(n => q ? n.toLowerCase().includes(q) : true);
         if (!names.length) { console.log("(no presets found)"); return; }
         for (const n of names) {
            const tag = user[n] ? " [user]" : "";
            console.log(`${n}${tag}`);
         }
      })

   /* ---------------------------- preset show <name> --------------------------- */
   .command("preset show <name>", "Show a preset", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("format", { type: "string", choices: ["json", "yaml"], default: "json" })
      .option("pretty", { type: "boolean", default: true })
      .option("dirs", { type: "array", describe: "Extra user preset dir(s)" })
      , async (args) => {
         const all = await getAllPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
         const p = all[String(args.name)];
         if (!p) { console.error(`Preset not found: ${args.name}`); process.exit(2); }
         const out = { name: args.name, ...p };
         if (String(args.format) === "yaml") console.log(YAML.stringify(out));
         else console.log(JSON.stringify(out, null, args.pretty ? 2 : 0));
      })

   /* --------------------------- preset add <name> ----------------------------- */
   .command("preset add <name>", "Create/update a user preset", y => y
      .positional("name", { type: "string", demandOption: true, describe: "Preset name (e.g. my-company.laravel)" })
      .option("from", { type: "string", describe: "Read include/exclude from a .zipconfig / stub / yaml / json" })
      .option("include", { type: "array", describe: "Add include globs (repeatable)" })
      .option("exclude", { type: "array", describe: "Add exclude globs (repeatable)" })
      .option("dir", { type: "string", describe: "Preferred directory to save the preset (defaults to ~/.config/zipper/presets)" })
      , async (args) => {
         const name = String(args.name);

         // Build preset object
         let preset: any = { include: [], exclude: [] };

         // If --from provided, parse it and pull includes/excludes
         if (args.from) {
            const fp = String(args.from);
            const fs = await import("node:fs/promises");
            const p = await fs.readFile(fp, "utf8");
            let src: any;
            try { src = fp.endsWith(".json") ? JSON.parse(p) : YAML.parse(p); }
            catch { console.error("Failed to parse --from file."); process.exit(2); }
            // If it’s a .zipconfig with top-level fields, or package.json: { zipper: {...} }
            const cfg = src?.zipper ?? src ?? {};
            if (Array.isArray(cfg.include)) preset.include.push(...cfg.include);
            if (Array.isArray(cfg.exclude)) preset.exclude.push(...cfg.exclude);
         }

         if (args.include?.length) preset.include.push(...(args.include as string[]));
         if (args.exclude?.length) preset.exclude.push(...(args.exclude as string[]));

         // Dedup
         preset.include = Array.from(new Set(preset.include || []));
         preset.exclude = Array.from(new Set(preset.exclude || []));

         try {
            const saved = await saveUserPreset(name, preset, args.dir ? String(args.dir) : undefined);
            console.log(`✔ Saved user preset "${name}" at ${saved}`);
         } catch (e) {
            console.error(`Failed to save preset: ${(e as Error).message}`);
            process.exit(2);
         }
      })

   /* --------------------------- preset rm <name> ------------------------------ */
   .command("preset rm <name>", "Remove a user preset", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("dirs", { type: "array", describe: "Extra user preset dir(s)" })
      , async (args) => {
         const ok = await removeUserPreset(String(args.name), (args.dirs as string[] | undefined)?.map(String) ?? []);
         if (!ok) { console.error("Preset not found."); process.exit(2); }
         console.log("✔ Removed preset");
      })

   /* -------------------------------- stub ls --------------------------------- */
   .command("stub ls", "List global stub files", y => y
      .option("dir", { type: "string", default: "stubs", describe: "Local stubs dir" })
      .option("global-dir", { type: "array", describe: "Extra global stubs dir(s)" })
      .option("no-global", { type: "boolean", default: false, describe: "Disable global dirs" })
      , async (args) => {
         const local = path.isAbsolute(String(args.dir)) ? String(args.dir) : path.join(process.cwd(), String(args.dir));
         const globals = args["no-global"] ? [] : getGlobalStubDirs((args["global-dir"] as string[] | undefined)?.map(String) ?? []);

         async function ls(dir: string) {
            try {
               const entries = await fs.readdir(dir, { withFileTypes: true });
               return entries.filter(e => e.isFile()).map(e => e.name).filter(n => /\.(stub|ya?ml|json)$/i.test(n));
            } catch { return []; }
         }

         const localList = await ls(local);
         console.log(localList.length ? `[local] ${local}` : `[local] ${local} (empty)`);
         for (const n of localList) console.log("  " + n);

         for (const g of globals) {
            const gl = await ls(g);
            console.log(gl.length ? `[global] ${g}` : `[global] ${g} (empty)`);
            for (const n of gl) console.log("  " + n);
         }
      })

   /* ------------------------------- stub add --------------------------------- */
   .command("stub add <file>", "Copy a stub file into your global stubs directory", y => y
      .positional("file", { type: "string", demandOption: true })
      .option("to", { type: "string", describe: "Target directory for global stubs (defaults to ~/.config/zipper/stubs)" })
      , async (args) => {
         const src = path.resolve(String(args.file));
         const content = await fs.readFile(src, "utf8");
         const home = os.homedir();
         const targetDir = args.to
            ? path.resolve(String(args.to))
            : path.join(home, ".config", "zipper", "stubs");

         await fs.mkdir(targetDir, { recursive: true });
         const dst = path.join(targetDir, path.basename(src));
         await fs.writeFile(dst, content, "utf8");
         console.log(`✔ Copied to ${dst}`);
      })

   /* ------------------------- preset export <name> ------------------------- */
   .command("preset export <name>", "Export a preset to a file", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("to", { type: "string", describe: "Output file path (defaults to ./<name>.yml)" })
      .option("format", { type: "string", choices: ["auto", "yaml", "json"], default: "auto", describe: "Output format; 'auto' infers from extension" })
      .option("pretty", { type: "boolean", default: true, describe: "Pretty-print JSON" })
      .option("dirs", { type: "array", describe: "Extra user preset dir(s) to search" })
      , async (args) => {
         const name = String(args.name);
         const all = await getAllPresets((args.dirs as string[] | undefined)?.map(String) ?? []);
         const preset = all[name];
         if (!preset) {
            console.error(`Preset not found: ${name}`);
            process.exit(2);
         }

         // choose output path
         let outPath = args.to ? String(args.to) : `./${name}.yml`;
         const ext = outPath.toLowerCase().endsWith(".json") ? "json"
            : outPath.toLowerCase().endsWith(".yml") || outPath.toLowerCase().endsWith(".yaml") ? "yaml"
               : (args.format as string);

         const data = { name, ...preset };
         let content: string;

         if (ext === "json") {
            content = JSON.stringify(data, null, args.pretty ? 2 : 0);
            if (!outPath.toLowerCase().endsWith(".json")) outPath = outPath + ".json";
         } else { // yaml or auto default
            content = YAML.stringify(data);
            if (!/\.(ya?ml)$/i.test(outPath)) outPath = outPath + ".yml";
         }

         await (await import("node:fs/promises")).writeFile(outPath, content, "utf8");
         console.log(`✔ Exported preset "${name}" to ${outPath}`);
      })

   /* -------------------------- preset import <name> -------------------------- */
   /* Convenience alias for `preset add <name> --from <file>` */
   .command("preset import <name>", "Create/update a user preset from a config/stub file", y => y
      .positional("name", { type: "string", demandOption: true })
      .option("from", { type: "string", demandOption: true, describe: "Path to .zipconfig / stub / yaml / json" })
      .option("dir", { type: "string", describe: "Preferred directory to save the preset (defaults to ~/.config/zipper/presets)" })
      , async (args) => {
         const { default: fs } = await import("node:fs/promises");
         const fp = String(args.from);
         const raw = await fs.readFile(fp, "utf8");
         let src: any;
         try { src = fp.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw); }
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
            console.error(`Failed to import preset: ${(e as Error).message}`);
            process.exit(2);
         }
      })

   /* ------------------------- preset rename <old> <new> ------------------------- */
   .command("preset rename <old> <new>", "Rename a user preset", y => y
      .positional("old", { type: "string", demandOption: true })
      .positional("new", { type: "string", demandOption: true })
      .option("dirs", { type: "array", describe: "Extra user preset dir(s) to search" })
      .option("dir", { type: "string", describe: "Preferred directory to save the renamed preset" })
      , async (args) => {
         const oldName = String(args.old);
         const newName = String(args.new);
         const userMap = await loadUserPresets((args.dirs as string[] | undefined)?.map(String) ?? []);

         const payload = userMap[oldName];
         if (!payload) {
            console.error(`User preset not found: ${oldName}`);
            process.exit(2);
         }

         try {
            const saved = await saveUserPreset(newName, payload, args.dir ? String(args.dir) : undefined);
            // try to delete old one
            await removeUserPreset(oldName, (args.dirs as string[] | undefined)?.map(String) ?? []);
            console.log(`✔ Renamed "${oldName}" → "${newName}"\n  → ${saved}`);
         } catch (e) {
            console.error(`Failed to rename: ${(e as Error).message}`);
            process.exit(2);
         }
      })

   /* ------------------------------ preset migrate ------------------------------ */
   .command("preset migrate", "Bulk-import presets from stub/config files", y => y
      .option("all", { type: "boolean", default: false, describe: "Migrate all files in from-dir (non-interactive)" })
      .option("from-dir", { type: "string", default: "stubs", describe: "Directory to scan for stubs/configs" })
      .option("include-globals", { type: "boolean", default: false, describe: "Also scan global stub directories" })
      .option("global-dir", { type: "array", describe: "Extra global stub dir(s) to include" })
      .option("dir", { type: "string", describe: "Destination user preset directory (defaults to ~/.config/zipper/presets)" })
      .option("dry-run", { type: "boolean", default: false })
      .option("interactive", { type: "boolean", default: undefined, describe: "Force interactive multi-select" })
      , async (args) => {
         const localDir = path.isAbsolute(String(args["from-dir"])) ? String(args["from-dir"]) : path.join(process.cwd(), String(args["from-dir"]));
         const extras = (args["global-dir"] as string[] | undefined)?.map(String) ?? [];

         // helper to list candidates
         async function list(dir: string): Promise<string[]> {
            try {
               const ents = await fs.readdir(dir, { withFileTypes: true });
               return ents
                  .filter(e => e.isFile())
                  .map(e => path.join(dir, e.name))
                  .filter(full => /\.(stub|ya?ml|json)$/i.test(full));
            } catch { return []; }
         }

         // gather candidates
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
            const tag = dir.includes(".config/zipper/stubs") || dir.endsWith(".zipper/stubs") ? "global" :
               dir.endsWith("/stubs") || dir.endsWith("\\stubs") ? "local" : "other";
            return `[${tag}] ${base}  ${pc.dim(path.relative(process.cwd(), dir) || ".")}`;
         });

         let selected: number[];
         const doInteractive = args.interactive || !args.all;

         if (doInteractive) {
            // pre-check everything if --all was also passed
            const pre = files.map(() => !!args.all);
            selected = await multiSelectPrompt("Select files to migrate into user presets", labels, pre);
            if (!selected.length) {
               console.log("(nothing selected)");
               return;
            }
         } else {
            // non-interactive + --all: select all
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

            if (args["dry-run"]) {
               console.log(`would import: ${name}  ←  ${file}`);
               continue;
            }

            try {
               //@ts-ignore
               const saved = await saveUserPreset(name, { include, exclude }, destDir);
               console.log(`✔ imported: ${name}  ←  ${file}\n  → ${saved}`);
               migrated++;
            } catch (e) {
               console.warn(`Failed to import ${name}: ${(e as Error).message}`);
            }
         }

         if (!args["dry-run"]) {
            console.log(`\nDone. Migrated ${migrated} preset(s).`);
         }
      })
   .demandCommand(1)
   .help()
   .strict()
   .parse();