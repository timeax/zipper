import { cosmiconfig } from "cosmiconfig";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import Ajv from "ajv";
import type { PreprocessHandler, ZipConfig } from "./types.js";
import { resolvePresets } from "./presets.js";
import { getBuiltinStubDir } from "./utils.js";
import pc from "picocolors";
import { pathToFileURL } from "node:url";

const MODULE_NAME = "zipper";
const SCHEMA_PATH = new URL("../schema/zipconfig.schema.json", import.meta.url);

/** If the user passed an explicit path with no extension, assume ".stub". */
export function appendStubIfNoExt(p: string): string {
   return path.extname(p) ? p : `${p}.stub`;
}

function envExpand(s: string) {
   return s.replace(/\$\{?([A-Z0-9_]+)\}?/gi, (_, k) => process.env[k] ?? "");
}

function parseUnknownConfig(content: string) {
   try { return JSON.parse(content); } catch { return YAML.parse(content); }
}

export async function loadConfig(explicitPath?: string): Promise<{ cfg: ZipConfig; filepath?: string; }> {
   const explorer = cosmiconfig(MODULE_NAME, {
      searchPlaces: [
         ".zipconfig",
         "zip.json",
         ".zipconfig.json",
         ".zipconfig.yaml",
         ".zipconfig.yml",
         "package.json"
      ],
      loaders: {
         ".yaml": (_fp, content) => YAML.parse(content),
         ".yml": (_fp, content) => YAML.parse(content),
         noExt: (_fp, content) => parseUnknownConfig(content), // extensionless .zipconfig
      }
   });

   let result: { config: unknown; filepath?: string } | undefined;

   if (explicitPath) {
      let fp = appendStubIfNoExt(explicitPath);
      if (fp.endsWith(".stub")) {
         const abs = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
         let content: string | null = null;

         // 1) exact path
         if (fs.existsSync(abs)) content = fs.readFileSync(abs, "utf8");

         // 2) ./stubs/<name>.stub (project local)
         if (content === null) {
            const local = path.join(process.cwd(), "stubs", path.basename(abs));
            if (fs.existsSync(local)) content = fs.readFileSync(local, "utf8");
         }

         // 3) built-in stubs ✅ always checked
         if (content === null) {
            const builtin = path.join(getBuiltinStubDir(), path.basename(abs));
            if (fs.existsSync(builtin)) content = fs.readFileSync(builtin, "utf8");
         }

         if (content !== null) {
            result = { config: parseUnknownConfig(content), filepath: abs };
         } else {
            throw new Error(`Config not found: ${explicitPath} (.stub assumed). Looked in: ${abs}, ./stubs, and built-in stubs.`);
         }
      } else {
         const r = await explorer.load(fp);
         if (r) result = { config: r.config, filepath: r.filepath };
      }
   } else {
      const r = await explorer.search();
      if (r) result = { config: r.config, filepath: r.filepath };
   }

   const raw = (result?.config && (result.config as any).zipper)
      ? (result!.config as any).zipper as Partial<ZipConfig>
      : (result?.config as Partial<ZipConfig> | undefined);

   const defaults: ZipConfig = {
      out: "dist.zip",
      root: ".",
      include: ["**/*"],
      exclude: [],
      dot: true,
      followSymlinks: false,
      order: ["include", "exclude"],
      presets: [],
      respectGitignore: false,
      ignoreFiles: [".zipignore"],
      deterministic: true,
      manifest: true
   };

   const presetMerge = resolvePresets(raw?.presets);
   const merged: ZipConfig = { ...defaults, ...presetMerge, ...raw };

   // ENV expansion
   merged.out = envExpand(merged.out);
   if (merged.root) merged.root = envExpand(merged.root);

   // Optional JSON Schema validation (warn-only)
   try {
      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
      const ajv = new Ajv({ allowUnionTypes: true, allErrors: true });
      const validate = ajv.compile(schema);
      if (!validate(merged)) {
         const msgs = (validate.errors ?? []).map(e => `${e.instancePath || "<root>"} ${e.message}`).join("; ");
         throw new Error(`Invalid .zipconfig: ${msgs}`);
      }
   } catch (e) {
      console.warn(`[zipper] config validation warning: ${(e as Error).message}`);
   }

   return { cfg: merged, filepath: result?.filepath };
}

export function loadListFile(root: string, listPath?: string): string[] {
   if (!listPath) return [];
   const full = path.isAbsolute(listPath) ? listPath : path.join(root, listPath);
   if (!fs.existsSync(full)) return [];
   return fs.readFileSync(full, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

export function readIgnoreFiles(root: string, files: string[] | undefined): string[] {
   const out: string[] = [];
   for (const rel of files ?? []) {
      const fp = path.isAbsolute(rel) ? rel : path.join(root, rel);
      if (fs.existsSync(fp)) {
         out.push(...fs.readFileSync(fp, "utf8").split(/\r?\n/));
      }
   }
   return out;
}



export async function loadPreprocessHandlers(
  cfg: ZipConfig,
  root: string,
  extraModuleFromCli?: string | string[]
): Promise<PreprocessHandler[]> {
  const modulesFromCfg = Array.isArray(cfg.preprocess?.modules)
    ? cfg.preprocess!.modules
    : (cfg.preprocess?.module ? [cfg.preprocess!.module] : []);

  const modulesFromCli = Array.isArray(extraModuleFromCli)
    ? extraModuleFromCli
    : (extraModuleFromCli ? [extraModuleFromCli] : []);

  const modules = [...modulesFromCfg, ...modulesFromCli];
  if (!modules.length) return [];

  const out: PreprocessHandler[] = [];
  for (const modPath of modules) {
    const abs = path.isAbsolute(modPath)
      ? modPath
      : path.resolve(root, String(modPath));

    if (!fs.existsSync(abs)) {
      console.warn(pc.yellow(`preprocess: module not found: ${modPath}`));
      continue;
    }

    const handlers = await importHandlers(abs);
    if (!handlers.length) {
      console.warn(pc.yellow(`preprocess: no handlers exported by ${modPath}`));
      continue;
    }

    out.push(...handlers);
  }

  return out;
}

async function importHandlers(absFile: string): Promise<PreprocessHandler[]> {
  const lower = absFile.toLowerCase();
  let mod: any;

  if (lower.endsWith('.ts')) {
    // Compile TS to ESM in-memory and import
    let esbuild: typeof import('esbuild');
    try { esbuild = await import('esbuild'); }
    catch {
      throw new Error(`To use TS preprocess module (${absFile}), install "esbuild".`);
    }
    const src = await fs.promises.readFile(absFile, 'utf8');
    const out = await esbuild.transform(src, {
      loader: 'ts',
      format: 'esm',
      sourcemap: 'inline',
      sourcefile: absFile,
      target: 'es2020',
    });
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(out.code).toString('base64');
    mod = await import(dataUrl);
  } else if (lower.endsWith('.mjs') || lower.endsWith('.js')) {
    mod = await import(pathToFileURL(absFile).href);
  } else {
    throw new Error(`Unsupported preprocess module extension: ${absFile}`);
  }

  const cand = mod?.default ?? mod?.handlers ?? [];
  if (Array.isArray(cand)) return cand;
  if (typeof cand === 'function') return [cand];
  return [];
}