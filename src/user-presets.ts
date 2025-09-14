// src/user-presets.ts
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

export type PresetLike = { include?: string[]; exclude?: string[]; [k: string]: any };

function isDir(p: string) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string) { try { return fs.statSync(p).isFile(); } catch { return false; } }

export function getPresetDirs(extra: string[] = []): string[] {
  const env = (process.env.ZIPPER_PRESETS ?? "").split(path.delimiter).map(s => s.trim()).filter(Boolean);
  const home = os.homedir();
  const defaults = [
    path.join(home, ".config", "zipper", "presets"),
    path.join(home, ".zipper", "presets"),
  ];
  const all = [...extra, ...env, ...defaults];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of all) {
    const abs = path.isAbsolute(d) ? d : path.resolve(process.cwd(), d);
    if (!seen.has(abs) && isDir(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}

/** Ensure a writable user presets dir (create if missing) */
export async function ensureUserPresetDir(preferred?: string): Promise<string> {
  const home = os.homedir();
  const candidates = preferred
    ? [preferred]
    : [path.join(home, ".config", "zipper", "presets"), path.join(home, ".zipper", "presets")];

  for (const d of candidates) {
    const abs = path.isAbsolute(d) ? d : path.resolve(process.cwd(), d);
    try {
      await fsp.mkdir(abs, { recursive: true });
      // test write permission
      await fsp.writeFile(path.join(abs, ".write-test"), "ok");
      await fsp.unlink(path.join(abs, ".write-test"));
      return abs;
    } catch { /* try next */ }
  }
  throw new Error("Could not create a writable user presets directory.");
}

/** Load all user presets (each file: *.yml|*.yaml|*.json) merged into one map */
export async function loadUserPresets(extraDirs: string[] = []): Promise<Record<string, PresetLike>> {
  const dirs = getPresetDirs(extraDirs);
  const out: Record<string, PresetLike> = {};
  for (const d of dirs) {
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(ya?ml|json)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        const content = await fsp.readFile(full, "utf8");
        const data = e.name.endsWith(".json") ? JSON.parse(content) : YAML.parse(content);
        const name = path.basename(e.name).replace(/\.(ya?ml|json)$/i, "");
        if (data && typeof data === "object") out[name] = data as PresetLike;
      } catch { /* ignore bad files */ }
    }
  }
  return out;
}

export async function saveUserPreset(name: string, preset: PresetLike, preferredDir?: string): Promise<string> {
  if (!name.match(/^[a-z0-9][a-z0-9._-]*$/i)) throw new Error("Invalid preset name.");
  const dir = await ensureUserPresetDir(preferredDir);
  const file = path.join(dir, `${name}.yml`);
  const yml = YAML.stringify(preset);
  await fsp.writeFile(file, yml, "utf8");
  return file;
}

export async function removeUserPreset(name: string, extraDirs: string[] = []): Promise<boolean> {
  const dirs = getPresetDirs(extraDirs);
  for (const d of dirs) {
    for (const ext of [".yml", ".yaml", ".json"]) {
      const file = path.join(d, `${name}${ext}`);
      if (isFile(file)) {
        await fsp.unlink(file);
        return true;
      }
    }
  }
  return false;
}