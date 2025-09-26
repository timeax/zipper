// src/hooks_meta.ts
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { cosmiconfig } from "cosmiconfig";
import { MODULE_NAME, getBuiltinStubDir, appendStubIfNoExt, parseUnknownConfig, envExpand } from "./utils";
import type { HooksConfig } from "./types.js";

export async function loadHooksMeta(explicitPath?: string): Promise<{ hooks?: HooksConfig; root?: string; out?: string; filepath?: string; }> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [".zipconfig","zip.json",".zipconfig.json",".zipconfig.yaml",".zipconfig.yml","package.json"],
    loaders: {
      ".yaml": (_fp, content) => YAML.parse(content),
      ".yml": (_fp, content) => YAML.parse(content),
      noExt: (_fp, content) => parseUnknownConfig(content),
    }
  });

  let result: { config: any; filepath?: string } | undefined;

  if (explicitPath) {
    let fp = appendStubIfNoExt(explicitPath);
    if (fp.endsWith(".stub")) {
      const abs = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
      let content: string | null = null;
      if (fs.existsSync(abs)) content = fs.readFileSync(abs, "utf8");
      if (content === null) {
        const local = path.join(process.cwd(), "stubs", path.basename(abs));
        if (fs.existsSync(local)) content = fs.readFileSync(local, "utf8");
      }
      if (content === null) {
        const builtin = path.join(getBuiltinStubDir(), path.basename(abs));
        if (fs.existsSync(builtin)) content = fs.readFileSync(builtin, "utf8");
      }
      if (content !== null) result = { config: parseUnknownConfig(content), filepath: abs };
    } else {
      const r = await explorer.load(fp);
      if (r) result = { config: r.config, filepath: r.filepath };
    }
  } else {
    const r = await explorer.search();
    if (r) result = { config: r.config, filepath: r.filepath };
  }

  const raw = result?.config?.zipper ?? result?.config ?? {};
  // env expand minimal fields
  const out = raw.out ? envExpand(raw.out) : undefined;
  const root = raw.root ? envExpand(raw.root) : undefined;

  return {
    hooks: raw.hooks,
    root,
    out,
    filepath: result?.filepath
  };
}