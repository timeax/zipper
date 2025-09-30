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

   hooks?: HooksConfig;

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

// src/types.ts
export type HookItem =
   | string
   | {
      run: string | string[];           // "npm run build" OR ["node", "script.js", "--flag"]
      shell?: boolean;                  // default true for strings, false for arrays
      cwd?: string;                     // default: cfg.root
      timeoutMs?: number;               // default: 10 * 60 * 1000
      env?: Record<string, string>;     // extra env vars
      continueOnError?: boolean;        // default false
   };

export type HooksConfig = {
   pre?: HookItem[];
   post?: HookItem[];
};

/* ===================== Remote deploy option shapes ===================== */
// ---------- Shared remote base ----------
export type RemoteConfirmMode = "auto" | "always" | "never";

export type RemoteBase = {
   /** Server IP/hostname or alias (when alias provides User, `user` can be omitted) */
   host: string;
   user?: string;
   /** Domain used to derive default WEBROOT unless overridden */
   domain?: string;
   /** Preserve (skip delete/overwrite) inside docroot */
   preservePaths?: string[];
   /** Where backups live (remote paths for SSH; descriptive for FTP restore) */
   backupDir?: string;
   backupPrefix?: string;
   backupRetain?: number;
   /** Override computed locations */
   webroot?: string;
   remoteTmp?: string;
   /** Behavior */
   dryRun?: boolean;
   timeoutMs?: number;
   confirm?: RemoteConfirmMode;
   /** Extra env passed through to scripts/runtimes */
   extraEnv?: Record<string, string>;
};

// ---------- FTP ----------
export type FtpSecurity = "none" | "explicit" | "implicit";

export interface RemoteFtpOpts extends RemoteBase {
   user: string;               // FTP always needs username
   password: string;           // and password (or app-password)
   /** Path to the ZIP artifact to deploy */
   zipPath: string;
   /** Remote docroot */
   webroot?: string;
   /** FTPS/FTP options */
   secure?: FtpSecurity;       // default "explicit"
   port?: number;              // default 21 or 990 when implicit
   secureOptions?: any;        // TLS options (keep as `any` to avoid importing basic-ftp types)
   /** Client behavior */
   concurrency?: number;       // parallel uploads (default 4)
   yes?: boolean;              // pre-approve confirmation
}

/** Restore over FTP from a local backup archive (zip/tar.gz) */
export type RestoreFtpOpts = Omit<RemoteFtpOpts,
   "zipPath" | "concurrency"
> & {
   /** Local backup archive path (.zip | .tar.gz | .tgz) */
   backupPath: string;
   /** Client behavior */
   concurrency?: number;
};

// ---------- SSH / SFTP (if you centralize them too) ----------
export interface RemoteSshOpts extends RemoteBase {
   /** ZIP to upload & deploy */
   zipPath: string;
   sshPort?: number;
   sshKeyPath?: string;
   sshOpts?: string;
}

export type RestoreSshOpts = Omit<RemoteSshOpts, "zipPath"> & {
   /** If omitted, restore script picks latest by prefix */
   backupName?: string;
};

// (Optional) SFTP mirror of FTP auth semantics
export interface RemoteSftpOpts extends RemoteBase {
   user: string;
   password?: string;
   /** ZIP to upload & deploy */
   zipPath: string;
   /** Remote docroot */
   webroot?: string;
   port?: number;              // default 22
   /** Client behavior */
   concurrency?: number;
   yes?: boolean;
}

// ---------- Deploy config on ZipConfig ----------
export type DeployBackend = "shell" | "sftp" | "ftp";

// NOTE: original snippet had a typo "RemoteShhOpts". Use RemoteSshOpts.
export type DeployTarget = RemoteSshOpts | RemoteFtpOpts | RemoteSftpOpts;

export type DeployConfig = {
   default?: DeployBackend;
   targets: Partial<Record<DeployBackend, DeployTarget>>;
};

// Extend your existing ZipConfig (don’t duplicate other fields here)
export interface ZipConfig {
   // ...existing fields...
   deploy?: DeployConfig;
}