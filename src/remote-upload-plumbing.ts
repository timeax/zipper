// remote-upload-plumbing.ts
import type { Argv } from "yargs";

export function attachRemoteUploadOptions<T>(y: Argv<T>) {
  return y
    .option("remote", { type: "string", describe: "Upload after pack via backend: shell | ftp | sftp. Omit value to use config default." })
    // Common overrides
    .option("host", { type: "string" })
    .option("user", { type: "string" })
    .option("domain", { type: "string" })
    .option("webroot", { type: "string" })
    .option("preserve", { type: "string", describe: "Comma/newline list of preserve paths" })
    .option("timeout", { type: "number" })
    .option("concurrency", { type: "number" })
    .option("confirm", { type: "string", choices: ["auto","always","never"] as any })
    .option("yes", { type: "boolean", describe: "Auto-confirm" })
    .option("force", { type: "boolean", describe: "Alias of --yes" })
    // Port / auth (shared)
    .option("port", { type: "number" })
    .option("pass", { type: "string" })
    .option("password", { type: "string" })
    // FTP only
    .option("secure", { type: "string", choices: ["none","explicit","implicit"] as any })
    // SSH only
    .option("ssh-port", { type: "number" })
    .option("ssh-key", { type: "string" })
    .option("ssh-opts", { type: "string" })
    .option("backup-dir", { type: "string" })
    .option("backup-prefix", { type: "string" })
    .option("backup-retain", { type: "number" })
    .option("remote-tmp", { type: "string" });
}

export function collectRemoteUploadArgs(argv: Record<string, any>, zipOutAbs: string) {
  // only copy keys that were actually provided on the CLI
  const take = (k: string) => (k in argv ? argv[k] : undefined);
  const out: Record<string, any> = {};

  const keys = [
    "host","user","domain","webroot","preserve",
    "dry-run","timeout","concurrency","confirm","yes","force",
    "port","pass","password","secure",
    "ssh-port","ssh-key","ssh-opts","backup-dir","backup-prefix","backup-retain","remote-tmp"
  ];
  for (const k of keys) if (k in argv) out[k] = argv[k];

  // ensure the zip path we just built wins
  out.zip = zipOutAbs;
  return out;
}