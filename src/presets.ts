// src/presets.ts
import type { GroupConfig, ZipConfig } from "./types.js";
import { loadUserPresets } from "./user-presets.js";

type PresetMap = Record<string, Partial<ZipConfig>>;

export const PRESETS: PresetMap = {
   "laravel-basic": {
      include: [
         "app/**", "bootstrap/**", "config/**", "database/**",
         "public/**", "resources/**", "routes/**",
         "artisan", "composer.*", "package.json"
      ],
      exclude: [
         "node_modules/**",
         "vendor/**",
         "storage/logs/**/*",
         "storage/framework/**/*", // files only; dirs can be kept via placeholders
         ".env*",
         ".git/**",
         "**/*.map"
      ]
   },

   "laravel-no-vendor": {
      include: [
         "app/**", "bootstrap/**", "config/**", "database/**",
         "public/**", "resources/**", "routes/**",
         "artisan", "composer.*", "package.json"
      ],
      exclude: [
         "vendor/**",
         "node_modules/**",
         "storage/**/*",          // if you want folders kept, switch to logs/**/* + framework/**/* like above
         ".env*",
         ".git/**"
      ]
   },

   "node-module": {
      include: ["dist/**", "package.json", "README*", "LICENSE*"],
      exclude: ["**/*.map", ".git/**", "node_modules/**"]
   },

   // NEW
   "inertia": {
      include: [
         // server-side
         "app/**", "bootstrap/**", "config/**", "database/**", "routes/**",
         "artisan", "composer.*", ".env.example",

         // front-end source
         "resources/js/**", "resources/ts/**", "resources/css/**", "resources/sass/**",
         "resources/views/**", "resources/lang/**",
         "vite.config.*", "postcss.config.*", "tailwind.config.*",
         "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
         ".eslintrc.*", ".prettierrc*", ".editorconfig",

         // public runtime / built assets
         "public/index.php", "public/.htaccess", "public/build/**"
      ],
      exclude: [
         // deps
         "node_modules/**",
         "vendor/**",

         // storage (drop files but allow dirs to survive if you include placeholders)
         "storage/logs/**/*",
         "storage/framework/**/*",

         // public stuff you usually don’t want
         "public/hot",
         "public/storage/**",
         "public/*.map", "public/**/*.map",

         // sourcemaps anywhere
         "**/*.map",

         // VCS
         ".git/**"
      ]
   },
   /**
   * Laravel + Inertia with grouped archive layout:
   *   - server/  → backend + blade/lang
   *   - source/  → frontend sources + tooling
   *   - public/* → kept as-is (no double "public/public")
   */
   "inertia-grouped": {
      groups: {
         server: {
            target: "server/",
            priority: 10,
            include: [
               "app/**", "bootstrap/**", "config/**", "database/**", "routes/**",
               "artisan", "composer.*", ".env",
               "resources/views/**", "resources/lang/**",
               "vendor/**"
            ]
         },
         source: {
            target: "source/",
            priority: 5,
            include: [
               "resources/js/**", "resources/ts/**", "resources/css/**", "resources/sass/**",
               "vite.config.*", "postcss.config.*", "tailwind.config.*",
               "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
               ".eslintrc.*", ".prettierrc*", ".editorconfig"
            ],
            exclude: ["resources/views/**", "resources/lang/**"]
         },
         public: {
            // keep existing public/* paths as-is (avoid public/public/**)
            target: "",
            priority: 1,
            include: ["public/**"],
            exclude: ["public/hot", "public/storage/**", "public/*.map", "public/**/*.map", "public/index.php", "public/.htaccess"]
         },

         "./": {
            target: "",
            priority: 100,
            include: [
               "public/index.php", "public/.htaccess",
            ]
         }
      }
   }
};
// types assumed:
// type GroupConfig = { target: string; include: string[]; exclude?: string[]; priority?: number };
// type Preset = { include?: string[]; exclude?: string[]; ignoreFiles?: string[]; groups?: Record<string, GroupConfig>; preprocess?: { modules?: string[]; module?: string; includes?: string[]; excludes?: string[]; files?: string[]; maxBytes?: number; timeoutMs?: number; binaryMode?: "skip"|"pass"|"buffer"; } };
// type ZipConfig = { include?: string[]; exclude?: string[]; ignoreFiles?: string[]; groups?: Record<string, GroupConfig>; preprocess?: Preset["preprocess"]; /* ...other fields... */ };
// declare const PRESETS: Record<string, Preset>;

export function resolvePresets(names: string[] | undefined): Partial<ZipConfig> {
   if (!names?.length) return {};

   const merged: Partial<ZipConfig> = {};
   const accInclude: string[] = [];
   const accExclude: string[] = [];
   const accIgnoreFiles: string[] = [];
   const accGroups: Record<string, GroupConfig> = {};
   const accPre: NonNullable<ZipConfig["preprocess"]> = {
      includes: [],
      excludes: [],
      files: [],
      modules: []
   };

   for (const n of names) {
      const p = PRESETS[n];
      if (!p) continue;

      if (p.include?.length) accInclude.push(...p.include);
      if (p.exclude?.length) accExclude.push(...p.exclude);
      if (p.ignoreFiles?.length) accIgnoreFiles.push(...p.ignoreFiles);

      // ---- groups deep-merge
      if (p.groups) {
         for (const [gname, g] of Object.entries(p.groups)) {
            const cur = accGroups[gname];
            if (!cur) {
               accGroups[gname] = {
                  target: g.target ?? "",
                  include: [...(g.include ?? [])],
                  exclude: g.exclude?.length ? [...g.exclude] : undefined,
                  files: g.files?.length ? [...g.files] : undefined, // NEW
                  priority: g.priority ?? 0
               };
            } else {
               if (g.target != null) cur.target = g.target;
               if (g.priority != null) cur.priority = g.priority;
               if (g.include?.length) cur.include.push(...g.include);
               if (g.exclude?.length) cur.exclude = [...(cur.exclude ?? []), ...g.exclude];
               if (g.files?.length) cur.files = [...(cur.files ?? []), ...g.files]; // NEW
            }
         }
      }

      // ---- preprocess selector merge (optional; NO handlers here)
      if (p.preprocess) {
         const pr = p.preprocess;
         if (pr.includes?.length) accPre.includes!.push(...pr.includes);
         if (pr.excludes?.length) accPre.excludes!.push(...pr.excludes);
         if (pr.files?.length) accPre.files!.push(...pr.files);
         // accept either `module` or `modules`
         if (pr.modules?.length) accPre.modules!.push(...pr.modules);
         if (pr.module) accPre.modules!.push(pr.module);
         if (typeof pr.maxBytes === "number") accPre.maxBytes = pr.maxBytes;
         if (typeof pr.timeoutMs === "number") accPre.timeoutMs = pr.timeoutMs;
         if (typeof pr.binaryMode === "string") accPre.binaryMode = pr.binaryMode as any;
      }
   }

   // ---- finalize with de-dup (keep last occurrence)
   merged.include = uniqKeepLast(accInclude);
   merged.exclude = uniqKeepLast(accExclude);
   if (accIgnoreFiles.length) merged.ignoreFiles = uniqKeepLast(accIgnoreFiles);

   if (Object.keys(accGroups).length) {
      const outGroups: Record<string, GroupConfig> = {};
      for (const [k, g] of Object.entries(accGroups)) {
         outGroups[k] = {
            target: g.target,
            priority: g.priority,
            include: uniqKeepLast(g.include ?? []),
            ...(g.exclude?.length ? { exclude: uniqKeepLast(g.exclude) } : {}),
            ...(g.files?.length ? { files: uniqKeepLast(g.files) } : {}) // NEW
         };
      }
      merged.groups = outGroups;
   }

   // only attach preprocess if anything was set
   const hasPre =
      (accPre.includes?.length ?? 0) ||
      (accPre.excludes?.length ?? 0) ||
      (accPre.files?.length ?? 0) ||
      ((accPre.modules?.length ?? 0)) ||
      accPre.maxBytes != null ||
      accPre.timeoutMs != null ||
      accPre.binaryMode != null;

   if (hasPre) {
      const preOut: any = {};
      if (accPre.includes?.length) preOut.includes = uniqKeepLast(accPre.includes!);
      if (accPre.excludes?.length) preOut.excludes = uniqKeepLast(accPre.excludes!);
      if (accPre.files?.length) preOut.files = uniqKeepLast(accPre.files!);
      if (accPre.modules?.length) preOut.modules = uniqKeepLast(accPre.modules!);
      if (accPre.maxBytes != null) preOut.maxBytes = accPre.maxBytes;
      if (accPre.timeoutMs != null) preOut.timeoutMs = accPre.timeoutMs;
      if (accPre.binaryMode != null) preOut.binaryMode = accPre.binaryMode;
      merged.preprocess = preOut;
   }

   return merged;
}

// Keep the *last* duplicate (later presets win)
function uniqKeepLast<T>(arr: T[]): T[] {
   const res: T[] = [];
   const seen = new Set<string>();
   for (let i = arr.length - 1; i >= 0; i--) {
      const key = String(arr[i]);
      if (!seen.has(key)) {
         seen.add(key);
         res.unshift(arr[i]);
      }
   }
   return res;
}

/** Merge built-ins with user presets; user presets override name collisions */
export async function getAllPresets(extraDirs: string[] = []) {
   const user = await loadUserPresets(extraDirs);
   return { ...PRESETS, ...user } as Record<string, Partial<ZipConfig>>;
}
