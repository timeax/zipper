// src/remote.ts
import type { Argv } from "yargs";

import { loadConfig } from "./config"; // adjust if your loader file is named differently
import {
   uploadViaSSH, restoreViaSSH,
} from "./remote-ssh";
import {
   uploadViaFTP, restoreViaFTP,
} from "./remote-ftp";
import {
   uploadViaSFTP, restoreViaSFTP,
} from "./remote-sftp";

import type {
   RemoteSshOpts,
   RemoteFtpOpts,
   RemoteSftpOpts,
   RestoreFtpOpts,
   DeployBackend,
   ZipConfig,
} from "./types";
import { handleUpload } from "./handle-upload";
import pc from "picocolors";
/* --------------------------------- API ---------------------------------- */

export function registerCommands(cli: Argv) {
   /* --------------------------- upload:ssh --------------------------- */
   cli.command(
      "upload:ssh",
      "Upload & deploy over SSH (rsync-based server script)",
      y => y
         .option("config", { type: "string", desc: "Path to .zipconfig" })
         .option("host", { type: "string", desc: "SSH host/IP or alias" })
         .option("user", { type: "string", desc: "SSH user (optional if alias supplies it)" })
         .option("domain", { type: "string", desc: "Domain (derives WEBROOT if not provided)" })
         .option("zip", { type: "string", desc: "Path to artifact zip (defaults to cfg.out)" })
         .option("preserve", { type: "string", desc: "Comma/newline list of paths to preserve" })
         .option("webroot", { type: "string", desc: "Override webroot on the server" })
         .option("remote-tmp", { type: "string", desc: "Override remote tmp directory" })
         .option("ssh-port", { type: "number", desc: "SSH port" })
         .option("ssh-key", { type: "string", desc: "Private key path" })
         .option("ssh-opts", { type: "string", desc: "Extra raw SSH options" })
         .option("backup-dir", { type: "string", desc: "Remote backup dir" })
         .option("backup-prefix", { type: "string", desc: "Backup filename prefix" })
         .option("backup-retain", { type: "number", desc: "How many backups to retain" })
         .option("dry-run", { type: "boolean", default: false })
         .option("yes", { type: "boolean", default: false })
         .option("force", { type: "boolean", default: false })
         .option("timeout", { type: "number", desc: "Timeout (ms)" })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as const, default: "auto" }),
      async args => {
         const { cfg } = await loadConfig(args.config as string | undefined);
         const baseZip = cfg.out;
         const target = (cfg.deploy?.targets?.shell ?? {}) as Partial<RemoteSshOpts>;

         const opts: RemoteSshOpts = {
            host: pick(args.host, target.host)!,
            user: pick(args.user, target.user),
            domain: pick(args.domain, (target as any).domain)!,
            zipPath: pick(args.zip, target.zipPath, baseZip)!,

            preservePaths: split(args.preserve) ?? target.preservePaths,
            backupDir: pick(args["backup-dir"], target.backupDir),
            backupPrefix: pick(args["backup-prefix"], target.backupPrefix),
            backupRetain: num(args["backup-retain"], target.backupRetain),
            webroot: pick(args.webroot, target.webroot),
            remoteTmp: pick(args["remote-tmp"], (target as any).remoteTmp),
            sshPort: num(args["ssh-port"], (target as any).sshPort),
            sshKeyPath: pick(args["ssh-key"], (target as any).sshKeyPath),
            sshOpts: pick(args["ssh-opts"], (target as any).sshOpts),
            dryRun: bool(args["dry-run"], target.dryRun),
            timeoutMs: num(args.timeout, target.timeoutMs),
            confirm: pick(args.confirm, target.confirm) as any,
            extraEnv: {},
         };

         requireFields(opts, ["host", "domain", "zipPath"]);
         await uploadViaSSH(opts);
      }
   );

   /* -------------------------- restore:ssh --------------------------- */
   cli.command(
      "restore:ssh",
      "Restore site from a remote backup (SSH)",
      y => y
         .option("config", { type: "string" })
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("domain", { type: "string" })
         .option("webroot", { type: "string" })
         .option("backup-dir", { type: "string" })
         .option("backup-prefix", { type: "string" })
         .option("backup-name", { type: "string", desc: "Exact backup filename to restore" })
         .option("ssh-port", { type: "number" })
         .option("ssh-key", { type: "string" })
         .option("ssh-opts", { type: "string" })
         .option("dry-run", { type: "boolean", default: false })
         .option("yes", { type: "boolean", default: false })
         .option("timeout", { type: "number" }),
      async args => {
         const { cfg } = await loadConfig(args.config as string | undefined);
         const target = (cfg.deploy?.targets?.shell ?? {}) as Partial<RemoteSshOpts>;

         const opts = {
            host: pick(args.host, target.host)!,
            user: pick(args.user, target.user)!,
            domain: pick(args.domain, (target as any).domain)!,
            webroot: pick(args.webroot, target.webroot),
            backupDir: pick(args["backup-dir"], target.backupDir),
            backupPrefix: pick(args["backup-prefix"], target.backupPrefix),
            backupName: pick(args["backup-name"], undefined),
            sshPort: num(args["ssh-port"], (target as any).sshPort),
            sshKeyPath: pick(args["ssh-key"], (target as any).sshKeyPath),
            sshOpts: pick(args["ssh-opts"], (target as any).sshOpts),
            dryRun: bool(args["dry-run"], target.dryRun),
            force: bool(args["yes"], false),
            timeoutMs: num(args.timeout, target.timeoutMs),
            extraEnv: {},
         };

         requireFields(opts, ["host", "user", "domain"]);
         await restoreViaSSH(opts as any);
      }
   );

   /* --------------------------- upload:ftp --------------------------- */
   cli.command(
      "upload:ftp",
      "Upload & deploy over FTP/FTPS",
      y => y
         .option("config", { type: "string" })
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("pass", { type: "string", desc: "FTP password (or ZIPPER_FTP_PASS)" })
         .option("domain", { type: "string", desc: "Used to derive webroot if not provided" })
         .option("webroot", { type: "string" })
         .option("zip", { type: "string" })
         .option("preserve", { type: "string" })
         .option("secure", { type: "string", choices: ["none", "explicit", "implicit"] as const, default: "explicit" })
         .option("port", { type: "number" })
         .option("dry-run", { type: "boolean", default: false })
         .option("timeout", { type: "number" })
         .option("concurrency", { type: "number", default: 4 })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as const, default: "auto" })
         .option("yes", { type: "boolean", default: false }),
      async args => {
         const { cfg } = await loadConfig(args.config as string | undefined);
         const baseZip = cfg.out;
         const target = (cfg.deploy?.targets?.ftp ?? {}) as Partial<RemoteFtpOpts>;

         const domain = pick(args.domain, (target as any).domain);
         const user = pick(args.user, target.user);

         const webroot = pick(
            args.webroot,
            target.webroot,
            autoWebroot(user, domain)
         );

         const opts: RemoteFtpOpts = {
            host: pick(args.host, target.host)!,
            user: user!,
            password: pick(args.pass, (target as any).password, process.env.ZIPPER_FTP_PASS),
            webroot: webroot!,
            zipPath: pick(args.zip, target.zipPath, baseZip)!,
            preservePaths: split(args.preserve) ?? target.preservePaths,
            secure: pick(args.secure as any, (target as any).secure) ?? "explicit",
            port: num(args.port, target.port),
            dryRun: bool(args["dry-run"], target.dryRun),
            timeoutMs: num(args.timeout, target.timeoutMs),
            concurrency: num(args.concurrency, target.concurrency) ?? 4,
            confirm: pick(args.confirm as any, target.confirm) as any,
            yes: bool(args.yes, (target as any).yes),
         };

         requireFields(opts, ["host", "user", "webroot", "zipPath"]);
         await uploadViaFTP(opts);
      }
   );

   /* -------------------------- restore:ftp --------------------------- */
   cli.command(
      "restore:ftp",
      "Restore site over FTP/FTPS from a local backup archive",
      y => y
         .option("config", { type: "string" })
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("pass", { type: "string", desc: "FTP password (or ZIPPER_FTP_PASS)" })
         .option("domain", { type: "string" })
         .option("webroot", { type: "string" })
         .option("backup", { type: "string", desc: "Local backup file (.zip/.tar.gz/.tgz)" })
         .option("preserve", { type: "string" })
         .option("secure", { type: "string", choices: ["none", "explicit", "implicit"] as const, default: "explicit" })
         .option("port", { type: "number" })
         .option("dry-run", { type: "boolean", default: false })
         .option("timeout", { type: "number" })
         .option("concurrency", { type: "number", default: 4 })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as const, default: "auto" })
         .option("yes", { type: "boolean", default: false }),
      async args => {
         const { cfg } = await loadConfig(args.config as string | undefined);
         const target = (cfg.deploy?.targets?.ftp ?? {}) as Partial<RemoteFtpOpts>;

         const domain = pick(args.domain, (target as any).domain);
         const user = pick(args.user, target.user);

         const webroot = pick(
            args.webroot,
            (target as any).webroot,
            autoWebroot(user, domain)
         );

         const opts: RestoreFtpOpts = {
            host: pick(args.host, target.host)!,
            user: user!,
            password: pick(args.pass, (target as any).password, process.env.ZIPPER_FTP_PASS) || "",
            webroot: webroot!,
            backupPath: pick(args.backup, undefined)!,
            preservePaths: split(args.preserve) ?? target.preservePaths,
            secure: pick(args.secure as any, (target as any).secure) ?? "explicit",
            port: num(args.port, target.port),
            dryRun: bool(args["dry-run"], target.dryRun),
            timeoutMs: num(args.timeout, target.timeoutMs),
            concurrency: num(args.concurrency, target.concurrency) ?? 4,
            confirm: pick(args.confirm as any, target.confirm) as any,
            yes: bool(args.yes, (target as any).yes),
         };

         requireFields(opts, ["host", "user", "webroot", "backupPath"]);
         await restoreViaFTP(opts);
      }
   );

   /* --------------------------- upload:sftp -------------------------- */
   cli.command(
      "upload:sftp",
      "Upload & deploy over SFTP",
      y => y
         .option("config", { type: "string" })
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("pass", { type: "string", desc: "SFTP password (or ZIPPER_SFTP_PASS)" })
         .option("domain", { type: "string" })
         .option("webroot", { type: "string" })
         .option("zip", { type: "string" })
         .option("preserve", { type: "string" })
         .option("port", { type: "number", default: 22 })
         .option("dry-run", { type: "boolean", default: false })
         .option("timeout", { type: "number" })
         .option("concurrency", { type: "number", default: 4 })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as const, default: "auto" })
         .option("yes", { type: "boolean", default: false }),
      async args => {
         const { cfg } = await loadConfig(args.config as string | undefined);
         const baseZip = cfg.out;
         const target = (cfg.deploy?.targets?.sftp ?? {}) as Partial<RemoteSftpOpts>;

         const domain = pick(args.domain, (target as any).domain);
         const user = pick(args.user, (target as any).user);

         const webroot = pick(
            args.webroot,
            target.webroot,
            autoWebroot(user, domain)
         );

         const opts: RemoteSftpOpts = {
            host: pick(args.host, target.host)!,
            user: user!,
            password: pick(args.pass, (target as any).password, process.env.ZIPPER_SFTP_PASS),
            webroot: webroot!,
            zipPath: pick(args.zip, target.zipPath, baseZip)!,
            preservePaths: split(args.preserve) ?? target.preservePaths,
            port: num(args.port, target.port) ?? 22,
            dryRun: bool(args["dry-run"], target.dryRun),
            timeoutMs: num(args.timeout, target.timeoutMs),
            concurrency: num(args.concurrency, target.concurrency) ?? 4,
            confirm: pick(args.confirm as any, target.confirm) as any,
            yes: bool(args.yes, (target as any).yes),
         };

         requireFields(opts, ["host", "user", "webroot", "zipPath"]);
         await uploadViaSFTP(opts);
      }
   );

   /* -------------------------- restore:sftp -------------------------- */
   cli.command(
      "restore:sftp",
      "Restore site over SFTP from a local backup or a remote backup directory",
      y => y
         .option("config", { type: "string" })
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("pass", { type: "string", desc: "SFTP password (or ZIPPER_SFTP_PASS)" })
         .option("domain", { type: "string" })
         .option("webroot", { type: "string" })
         .option("port", { type: "number", default: 22 })
         .option("backup", { type: "string", desc: "Local backup file (.zip/.tar.gz/.tgz)" })
         .option("remote-dir", { type: "string", desc: "Remote backup directory" })
         .option("remote-prefix", { type: "string", desc: "Filter by filename prefix" })
         .option("remote-name", { type: "string", desc: "Exact backup file name in remote-dir" })
         .option("preserve", { type: "string" })
         .option("dry-run", { type: "boolean", default: false })
         .option("timeout", { type: "number" })
         .option("concurrency", { type: "number", default: 4 })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as const, default: "auto" })
         .option("yes", { type: "boolean", default: false }),
      async args => {
         const { cfg } = await loadConfig(args.config as string | undefined);
         const target = (cfg.deploy?.targets?.sftp ?? {}) as Partial<RemoteSftpOpts>;

         const domain = pick(args.domain, (target as any).domain);
         const user = pick(args.user, (target as any).user);

         const webroot = pick(
            args.webroot,
            target.webroot,
            autoWebroot(user, domain)
         );

         const conn: RemoteSftpOpts = {
            host: pick(args.host, target.host)!,
            user: user!,
            password: pick(args.pass, (target as any).password, process.env.ZIPPER_SFTP_PASS),
            webroot: webroot!,
            // zipPath not used for restore; supply placeholder
            zipPath: cfg.out,
            preservePaths: split(args.preserve) ?? target.preservePaths,
            port: num(args.port, target.port) ?? 22,
            dryRun: bool(args["dry-run"], target.dryRun),
            timeoutMs: num(args.timeout, target.timeoutMs),
            concurrency: num(args.concurrency, target.concurrency) ?? 4,
            confirm: pick(args.confirm as any, target.confirm) as any,
            yes: bool(args.yes, (target as any).yes),
         };

         const sel = {
            localBackupPath: pick(args.backup, undefined),
            remoteBackupDir: pick(args["remote-dir"], undefined),
            remoteBackupPrefix: pick(args["remote-prefix"], undefined),
            remoteBackupName: pick(args["remote-name"], undefined),
         };

         requireFields(conn, ["host", "user", "webroot"]);
         if (!sel.localBackupPath && !sel.remoteBackupDir) {
            throw new Error("Provide either --backup (local) OR --remote-dir (with optional --remote-prefix/--remote-name).");
         }

         await restoreViaSFTP(conn, sel as any);
      }
   );

   // -------------------- upload --------------------
   cli.command(
      "upload [flag]",
      "Upload the built ZIP to a remote (shell/ftp/sftp).",
      (y) => y
         .positional("flag", { type: "string", describe: "Deploy backend: shell | ftp | sftp (overrides config default)" })
         .option("config", { type: "string", describe: "Path to .zipconfig" })
         .option("zip", { type: "string", describe: "Path to ZIP (defaults to cfg.out)" })
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("domain", { type: "string" })
         .option("webroot", { type: "string" })
         .option("preserve", { type: "string", describe: "Comma/newline list of preserve paths" })
         .option("dry-run", { type: "boolean" })
         .option("timeout", { type: "number" })
         .option("concurrency", { type: "number" })
         .option("port", { type: "number" })
         .option("pass", { type: "string" })
         .option("password", { type: "string" })
         .option("secure", { type: "string", choices: ["none", "explicit", "implicit"] as any })
         .option("ssh-port", { type: "number" })
         .option("ssh-key", { type: "string" })
         .option("ssh-opts", { type: "string" })
         .option("backup-dir", { type: "string" })
         .option("backup-prefix", { type: "string" })
         .option("backup-retain", { type: "number" })
         .option("remote-tmp", { type: "string" })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as any })
         .option("yes", { type: "boolean", describe: "Auto-confirm" })
         .option("force", { type: "boolean", describe: "Alias of --yes" }),
      async (argv) => {
         const { cfg } = await loadConfig(argv.config as string | undefined);
         if (!cfg) { console.log(pc.red("[upload] Failed to load config.")); return; }
         await handleUpload(cfg as ZipConfig, argv.flag as string | undefined, argv as any);
      }
   );

   // -------------------- restore --------------------
   cli.command(
      "restore [flag]",
      "Restore a site from a backup (shell/ftp/sftp).",
      (y) => y
         .positional("flag", { type: "string", describe: "Deploy backend: shell | ftp | sftp (overrides config default)" })
         .option("config", { type: "string", describe: "Path to .zipconfig" })
         // common-ish
         .option("host", { type: "string" })
         .option("user", { type: "string" })
         .option("domain", { type: "string" })
         .option("webroot", { type: "string" })
         .option("preserve", { type: "string" })
         .option("dry-run", { type: "boolean" })
         .option("timeout", { type: "number" })
         .option("concurrency", { type: "number" })
         .option("port", { type: "number" })
         .option("yes", { type: "boolean" })
         .option("force", { type: "boolean" })
         .option("confirm", { type: "string", choices: ["auto", "always", "never"] as any })
         // ssh-specific
         .option("backup-dir", { type: "string" })
         .option("backup-prefix", { type: "string" })
         .option("backup-name", { type: "string" })
         .option("ssh-key", { type: "string" })
         .option("ssh-opts", { type: "string" })
         // ftp/sftp-specific
         .option("pass", { type: "string" })
         .option("password", { type: "string" })
         .option("backup", { type: "string", describe: "Local backup archive (.zip/.tar.gz)" })
         .option("remote-dir", { type: "string", describe: "Remote backup dir (SFTP pull)" })
         .option("remote-prefix", { type: "string", describe: "Prefix for selecting remote backup" })
         .option("remote-name", { type: "string", describe: "Exact remote backup filename" })
         .option("secure", { type: "string", choices: ["none", "explicit", "implicit"] as any }),
      async (argv) => {
         const { cfg } = await loadConfig(argv.config as string | undefined);
         if (!cfg) { console.log(pc.red("[restore] Failed to load config.")); return; }

         const dep = (cfg as ZipConfig).deploy;
         if (!dep || !dep.targets || Object.keys(dep.targets).length === 0) {
            console.log(pc.red("[restore] No deploy targets configured. Define `deploy.targets` in .zipconfig."));
            return;
         }

         const pick: DeployBackend =
            (argv.flag as DeployBackend) ??
            dep.default ??
            (Object.keys(dep.targets).find(k => (dep.targets as any)[k]) as DeployBackend);

         const t = (dep.targets as any)[pick];
         if (!t) { console.log(pc.red(`[restore] Backend "${pick}" has no target config.`)); return; }

         // helpers
         const val = (k: string) => (k in argv && typeof argv[k] === "string" ? String(argv[k]) : undefined);
         const bool = (k: string) => !!argv[k];
         const num = (k: string) => (k in argv ? Number(argv[k]) : undefined);
         const split = (v?: string) => (v ? v.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : undefined);
         const deriveWebroot = (user?: string, domain?: string) =>
            user && domain ? `/home/${user}/web/${domain}/public_html` : undefined;

         if (pick === "shell") {
            await restoreViaSSH({
               host: val("host") ?? t.host,
               user: val("user") ?? t.user,
               domain: val("domain") ?? t.domain,
               webroot: val("webroot") ?? t.webroot ?? deriveWebroot(val("user") ?? t.user, val("domain") ?? t.domain),
               backupDir: val("backup-dir") ?? t.backupDir,
               backupPrefix: val("backup-prefix") ?? t.backupPrefix,
               backupName: val("backup-name"),
               sshPort: num("port"),
               sshKeyPath: val("ssh-key"),
               sshOpts: val("ssh-opts"),
               dryRun: bool("dry-run") || !!t.dryRun,
               force: bool("yes") || bool("force"),
               timeoutMs: num("timeout") ?? t.timeoutMs,
               zipPath: cfg.out
            });
            return;
         }

         if (pick === "ftp") {
            const backupPath = val("backup");
            if (!backupPath) { console.log(pc.red("[restore] FTP restore requires --backup (local archive).")); return; }
            await restoreViaFTP({
               host: val("host") ?? t.host,
               user: val("user") ?? t.user,
               password: val("pass") ?? val("password") ?? t.password ?? process.env.ZIPPER_FTP_PASS ?? "",
               webroot: val("webroot") ?? t.webroot ?? deriveWebroot(val("user") ?? t.user, val("domain") ?? t.domain),
               backupPath,
               preservePaths: split(val("preserve")) ?? t.preservePaths,
               secure: ((): any => {
                  const s = val("secure");
                  return (s === "none" || s === "implicit" || s === "explicit") ? s : (t.secure ?? "explicit");
               })(),
               port: num("port") ?? t.port ?? ((t.secure ?? "explicit") === "implicit" ? 990 : 21),
               dryRun: bool("dry-run") || !!t.dryRun,
               timeoutMs: num("timeout") ?? t.timeoutMs,
               concurrency: num("concurrency") ?? t.concurrency ?? 4,
               confirm: ((): "auto" | "always" | "never" => {
                  const c = val("confirm");
                  return c === "always" || c === "never" ? c : (t.confirm ?? "auto");
               })(),
               yes: bool("yes") || bool("force") || t.yes,
            });
            return;
         }

         if (pick === "sftp") {
            await restoreViaSFTP(
               {
                  host: val("host") ?? t.host,
                  user: val("user") ?? t.user,
                  password: val("pass") ?? val("password") ?? t.password ?? process.env.ZIPPER_SFTP_PASS,
                  domain: val("domain") ?? t.domain,
                  webroot: val("webroot") ?? t.webroot ?? deriveWebroot(val("user") ?? t.user, val("domain") ?? t.domain),
                  zipPath: "unused.zip",
                  preservePaths: split(val("preserve")) ?? t.preservePaths,
                  port: num("port") ?? t.port ?? 22,
                  dryRun: bool("dry-run") || !!t.dryRun,
                  timeoutMs: num("timeout") ?? t.timeoutMs,
                  concurrency: num("concurrency") ?? t.concurrency ?? 4,
                  confirm: ((): "auto" | "always" | "never" => {
                     const c = val("confirm");
                     return c === "always" || c === "never" ? c : (t.confirm ?? "auto");
                  })(),
                  yes: bool("yes") || bool("force") || t.yes,
               },
               {
                  localBackupPath: val("backup"),
                  remoteBackupDir: val("remote-dir"),
                  remoteBackupPrefix: val("remote-prefix"),
                  remoteBackupName: val("remote-name"),
               }
            );
            return;
         }

         console.log(pc.red(`[restore] Unsupported deploy backend: ${pick}`));
         return;
      }
   );
   return cli; // allow chaining
}

/* ------------------------------- helpers ------------------------------- */

function pick<T>(...xs: (T | undefined)[]): T | undefined {
   for (const x of xs) if (x !== undefined && x !== null && String(x) !== "") return x;
   return undefined;
}
function num(...xs: (number | string | undefined)[]): number | undefined {
   for (const x of xs) {
      if (x === undefined || x === null || String(x) === "") continue;
      const n = typeof x === "number" ? x : Number(x);
      if (!Number.isNaN(n)) return n;
   }
   return undefined;
}
function bool(x?: unknown, fallback?: boolean) {
   if (x === undefined) return fallback;
   if (typeof x === "boolean") return x;
   const s = String(x).toLowerCase();
   if (["1", "true", "yes", "y"].includes(s)) return true;
   if (["0", "false", "no", "n"].includes(s)) return false;
   return fallback;
}
function split(v: unknown): string[] | undefined {
   if (v == null) return undefined;
   const s = String(v).trim();
   if (!s) return undefined;
   return s.split(/[\n,]+/).map(z => z.trim()).filter(Boolean);
}
function autoWebroot(user?: string, domain?: string) {
   if (!user || !domain) return undefined;
   return `/home/${user}/web/${domain}/public_html`;
}
function requireFields(obj: Record<string, any>, keys: string[]) {
   const missing = keys.filter(k => obj[k] === undefined || obj[k] === null || obj[k] === "");
   if (missing.length) {
      throw new Error(`Missing required: ${missing.join(", ")}`);
   }
}