// src/presets.ts
import type { ZipConfig } from "./types.js";
import { loadUserPresets } from "./user-presets.js";

type PresetMap = Record<string, Partial<ZipConfig>>;

export const PRESETS: PresetMap = {
   "laravel-basic": {
      include: ["app/**", "bootstrap/**", "config/**", "database/**", "public/**", "resources/**", "routes/**", "artisan", "composer.*", "package.json"],
      exclude: ["node_modules/**", "vendor/**", "storage/logs/**", "storage/framework/**", ".env*", ".git/**", "**/*.map"]
   },
   "laravel-no-vendor": {
      include: ["app/**", "bootstrap/**", "config/**", "database/**", "public/**", "resources/**", "routes/**", "artisan", "composer.*", "package.json"],
      exclude: ["vendor/**", "node_modules/**", "storage/**", ".env*", ".git/**"]
   },
   "node-module": {
      include: ["dist/**", "package.json", "README*", "LICENSE*"],
      exclude: ["**/*.map", ".git/**", "node_modules/**"]
   }
};

export function resolvePresets(names: string[] | undefined): Partial<ZipConfig> {
   if (!names?.length) return {};
   const merged: Partial<ZipConfig> = { include: [], exclude: [] };
   for (const n of names) {
      const p = (PRESETS as any)[n];
      if (!p) continue;
      if (p.include) (merged.include as string[]).push(...p.include);
      if (p.exclude) (merged.exclude as string[]).push(...p.exclude);
      Object.assign(merged, { ...p, include: merged.include, exclude: merged.exclude });
   }
   return merged;
}

/** Merge built-ins with user presets; user presets override name collisions */
export async function getAllPresets(extraDirs: string[] = []) {
   const user = await loadUserPresets(extraDirs);
   return { ...PRESETS, ...user } as Record<string, Partial<ZipConfig>>;
}