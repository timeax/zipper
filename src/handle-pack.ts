import path from "node:path";
import pc from "picocolors";
import { loadConfig, loadListFile, readIgnoreFiles, loadPreprocessHandlers } from "./config";
import { buildFileList, writeZip } from "./pack";
import { buildGroupZipMapper, mergeGroupFilesIntoInclude } from "./groups";
import { Order, ZipConfig, ProcessedEntry } from "./types";

async function handlePack(args: any) {
   const { cfg, filepath } = await loadConfig(args.config as string | undefined);

   // existing CLI → cfg overrides...
   if (args.out) cfg.out = String(args.out);
   if (args.root) cfg.root = String(args.root);
   if (args.include?.length) cfg.include = [...(cfg.include ?? []), ...args.include.map(String)];
   if (args.exclude?.length) cfg.exclude = [...(cfg.exclude ?? []), ...args.exclude.map(String)];
   if (args.order) cfg.order = (String(args.order).split(",") as Order);
   if (typeof args["respect-gitignore"] === "boolean") cfg.respectGitignore = args["respect-gitignore"];
   if (args["ignore-file"]?.length) cfg.ignoreFiles = [...(cfg.ignoreFiles ?? []), ...args["ignore-file"].map(String)];
   if (args["no-manifest"]) cfg.manifest = false;
   if (args["manifest-path"]) cfg.manifestPath = String(args["manifest-path"]);

   // NEW: allow selecting only specific groups from CLI
   const groupFilter = (args.group as string | string[] | undefined);
   const groupsSelected = (Array.isArray(groupFilter) ? groupFilter : (groupFilter ? [groupFilter] : []))
      .map(String);

   // If user selected groups, slim cfg.groups down to those
   if (groupsSelected.length && cfg.groups) {
      const pick: NonNullable<ZipConfig["groups"]> = {};
      for (const k of groupsSelected) if (cfg.groups[k]) pick[k] = cfg.groups[k];
      cfg.groups = pick;
   }

   // preprocess CLI overrides (if you added them)
   cfg.preprocess = cfg.preprocess ?? {};
   if (typeof args["preprocess-timeout"] === "number") cfg.preprocess.timeoutMs = Number(args["preprocess-timeout"]);
   if (typeof args["preprocess-max-bytes"] === "number") cfg.preprocess.maxBytes = Number(args["preprocess-max-bytes"]);
   if (typeof args["preprocess-binary-mode"] === "string") cfg.preprocess.binaryMode = String(args["preprocess-binary-mode"]) as any;
   const disablePre = !!args["no-preprocess"];
   const strictPre = !!args["strict-preprocess"];

   mergeGroupFilesIntoInclude(cfg); // NEW: ensure group files are included
   // Build base file list (relative to root)
   const root = path.resolve(process.cwd(), cfg.root ?? ".");
   const listExtra = loadListFile(root, args.from as string | undefined);
   const extraIgnore = readIgnoreFiles(root, cfg.ignoreFiles);
   const relFiles = await buildFileList(cfg, listExtra, extraIgnore);

   if (args["dry-run"]) {
      console.log(pc.dim(`# Config: ${filepath ?? "(defaults)"}  Root: ${cfg.root}`));
      relFiles.forEach(f => console.log(f));
      console.log(pc.green(`\n${relFiles.length} files selected.`));
      return;
   }

   if (!relFiles.length) {
      console.error(pc.red("No files matched your rules. Nothing to zip."));
      process.exit(2);
   }

   // --- apply groups mapping to build initial entries
   const { map: mapZipPath } = buildGroupZipMapper(cfg);
   let entries: ProcessedEntry[] = relFiles.map(rel => ({
      sourcePath: path.join(root, rel),
      zipPath: mapZipPath(rel), // either group target + rel or rel unchanged
   }));

   // --- load preprocess modules from config + CLI and attach handlers
   if (!disablePre) {
      const extraModules = (args["preprocess"] as string[] | undefined)?.map(String) ?? [];
      const handlers = await loadPreprocessHandlers(cfg, root, extraModules);
      cfg.preprocess!.handlers = [...(cfg.preprocess!.handlers ?? []), ...handlers];
   }

   // --- Run preprocess (if any)
   if (!disablePre && cfg.preprocess?.handlers?.length) {
      const { runPreprocessPipeline } = await import("./preprocess");
      try {
         const fileAbs = entries.map((e: any) => e.sourcePath);
         const result = await runPreprocessPipeline(fileAbs, root, cfg, { strict: strictPre });

         const byRel = new Map<string, ProcessedEntry>();
         for (const e of result.entries) {
            const rel = e.zipPath; // starts as rel; may be rewritten by preprocess
            byRel.set(rel, e);
         }

         const remapped: ProcessedEntry[] = [];
         let changed = 0, omitted = 0;

         for (const base of relFiles) {
            const e = byRel.get(base);
            if (!e) { omitted++; continue; }
            if ("content" in e) {
               const zp = (e.zipPath && e.zipPath !== base) ? e.zipPath : mapZipPath(base);
               remapped.push({ zipPath: zp, content: e.content });
               changed++;
            } else {
               const zp = (e.zipPath && e.zipPath !== base) ? e.zipPath : mapZipPath(base);
               remapped.push({ zipPath: zp, sourcePath: e.sourcePath });
            }
         }

         entries = remapped;
         if (changed || omitted) {
            console.log(pc.dim(`preprocess: ${changed} changed, ${omitted} omitted`));
         }
      } catch (e) {
         if (strictPre) {
            console.error(pc.red(`Preprocess error (strict): ${(e as Error).message}`));
            process.exit(2);
         } else {
            console.warn(pc.yellow(`Preprocess error (ignored): ${(e as Error).message}`));
         }
      }
   }

   // --- NEW: --list (final zip paths preview; no archive written)
   if (args["list"]) {
      console.log(pc.dim(`# Config: ${filepath ?? "(defaults)"}  Root: ${cfg.root ?? "."}`));
      for (const e of entries) console.log(e.zipPath);
      console.log(pc.green(`\n${entries.length} files (final zip paths).`));
      return;
   }

   // --- Write the archive
   const out = await writeZip(cfg, entries);
   console.log(pc.green(`✔ wrote ${out} (${entries.length} files)`));
}

export { handlePack };