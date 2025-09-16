export type Order = ["include", "exclude"] | ["exclude", "include"];

export interface ZipConfig {
   /** Output zip path (can include ${ENV_VARS}) */
   out: string;

   /** Root directory to resolve includes/excludes; defaults to CWD */
   root?: string;

   /** Glob patterns to include (gitignore-style globs supported) */
   include?: string[];

   /** Glob patterns to exclude; applied with `ignore` semantics */
   exclude?: string[];

   /** Whether to match dotfiles in globs (default true) */
   dot?: boolean;

   /** Follow symlinks during scanning (default false) */
   followSymlinks?: boolean;

   /** Rule application order; default ["include","exclude"] */
   order?: Order;

   /** Named presets to expand (e.g. ["laravel-basic"]) */
   presets?: string[];

   /** If true, read .gitignore from root and exclude matches */
   respectGitignore?: boolean;

   /** Optional external list file; one path per line */
   fromList?: string;

   /** If true, keep deterministic order for reproducible builds (default true) */
   deterministic?: boolean;

   /**additional ignore files (.zipignore etc.) */
   ignoreFiles?: string[];


   manifest?: boolean;               // default true
   manifestPath?: string;            // optional external path override

   preprocess?: PreprocessConfig;

   groups?: Record<string, GroupConfig>;
}


export type PreprocessConfig = {
   includes?: string[];
   excludes?: string[];
   files?: string[]; // explicit whitelist (in addition to include globs)
   handlers?: Array<PreprocessHandler>;
   maxBytes?: number;
   binaryMode?: 'skip' | 'pass' | 'buffer';
   timeoutMs?: number;
   modules?: string[];  // module paths to load handlers from
   module?: string;     // single module path to load handlers from
};

export type FileStats = {
   /** Absolute path on disk */
   abs: string;
   /** Path relative to root */
   rel: string;
   /** Path that would go into the zip (pre-rewrite) */
   zipPath: string;
   /** Node path bits */
   dir: string;
   base: string;     // filename with ext
   name: string;     // filename without ext
   ext: string;      // like '.js'
   size: number;     // bytes
   mtimeMs: number;  // modified time
   isText: boolean;  // best-effort
};

export type ProcessContext = {
   /** Config-effective root */
   root: string;
   /** Environment & flags */
   env: Record<string, string | undefined>;
   /** Build id/ts, CLI info, etc */
   buildId: string;
   /** Helper: text/binary detection, glob util, etc. */
   utils: {
      globMatch: (pattern: string, input: string) => boolean;
      isText: (buf: Buffer, filename: string) => boolean;
   };
};

export type ProcessReturn =
   | Buffer
   | string
   | null
   | undefined
   | { content: Buffer | string; path?: string };

export type PreprocessHandler =
   (args: { stats: FileStats; content: Buffer; ctx: ProcessContext }) =>
      Promise<ProcessReturn> | ProcessReturn;

export type ProcessedEntry =
   | { sourcePath: string; zipPath: string }          // copy from disk
   | { content: Buffer; zipPath: string };


export type GroupConfig =
   {
      /** Where files in this group appear inside the zip (e.g. "src/", "web/") */
      target: string;
      /** Optional excludes (relative to root) */
      exclude?: string[];
      /** Higher number wins when multiple groups match (default 0) */
      priority?: number;
   } & (
      | { include: string[]; files?: string[] } // include required (files optional)
      | { include?: string[]; files: string[] } // files required (include optional)
   );