import { cosmiconfig } from "cosmiconfig";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import Ajv from "ajv";
import type { ZipConfig } from "./types.js";
import { resolvePresets } from "./presets.js";

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
      ".yml":  (_fp, content) => YAML.parse(content),
      noExt:   (_fp, content) => parseUnknownConfig(content), // extensionless .zipconfig
    }
  });

  let result: { config: unknown; filepath?: string } | undefined;

  if (explicitPath) {
    let fp = appendStubIfNoExt(explicitPath);
    if (fp.endsWith(".stub")) {
      // Manual parse for .stub (YAML or JSON)
      const abs = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
      const content = fs.readFileSync(abs, "utf8");
      result = { config: parseUnknownConfig(content), filepath: abs };
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