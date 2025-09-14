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
}
