import path from "node:path";
import pc from "picocolors";
import type {
   ZipConfig,
   DeployBackend,
   RemoteSshOpts,
   RemoteFtpOpts,
   RemoteSftpOpts,
} from "./types";
import { uploadViaSSH } from "./remote-ssh";
import { uploadViaFTP } from "./remote-ftp";
import { uploadViaSFTP } from "./remote-sftp";

export async function handleUpload(cfg: ZipConfig, flag: string | undefined, args: Record<string, any>) {
   const dep = cfg.deploy;
   if (!dep || !dep.targets || Object.keys(dep.targets).length === 0) {
      console.log(pc.red("[deploy] No deploy targets configured. Define `deploy.targets` in .zipconfig."));
      return;
   }

   // Resolve backend: CLI flag -> cfg.deploy.default -> first configured
   const backend: DeployBackend | undefined =
      (flag as DeployBackend) ??
      dep.default ??
      (Object.keys(dep.targets).find(k => (dep.targets as any)[k]) as DeployBackend | undefined);

   if (!backend) {
      console.log(pc.red("[deploy] No deploy backend resolved. Pass --flag, set deploy.default, or configure at least one target."));
      return;
   }

   const rawTarget = (dep.targets as any)[backend];
   if (!rawTarget) {
      console.log(pc.red(`[deploy] Backend "${backend}" has no target config.`));
      return;
   }

   // Helpers
   const val = (k: string) => (k in args && typeof args[k] === "string" ? String(args[k]) : undefined);
   const bool = (k: string) => !!args[k];
   const num = (k: string) => (k in args ? Number(args[k]) : undefined);
   const split = (v?: string) => (v ? v.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : undefined);
   const deriveWebroot = (user?: string, domain?: string) =>
      user && domain ? `/home/${user}/web/${domain}/public_html` : undefined;

   // ZIP path defaults to cfg.out unless overridden
   const zipFromCfg = path.isAbsolute(cfg.out) ? cfg.out : path.resolve(process.cwd(), cfg.out);
   const zipPath = val("zip") ?? rawTarget.zipPath ?? zipFromCfg;

   if (!zipPath) {
      console.log(pc.red("[deploy] Missing zipPath. Provide --zip or set target.zipPath or set cfg.out."));
      return;
   }

   if (backend === "shell") {
      const base: RemoteSshOpts = {
         ...(rawTarget as RemoteSshOpts),
         host: val("host") ?? (rawTarget.host as any),
         user: val("user") ?? (rawTarget.user as any),
         domain: val("domain") ?? (rawTarget.domain as any),
         zipPath,
         preservePaths: split(val("preserve")) ?? rawTarget.preservePaths,
         backupDir: val("backup-dir") ?? rawTarget.backupDir,
         backupPrefix: val("backup-prefix") ?? rawTarget.backupPrefix,
         backupRetain: num("backup-retain") ?? rawTarget.backupRetain,
         webroot: val("webroot") ?? rawTarget.webroot ?? deriveWebroot(val("user") ?? rawTarget.user, val("domain") ?? rawTarget.domain),
         remoteTmp: val("remote-tmp") ?? rawTarget.remoteTmp,
         sshPort: num("ssh-port") ?? num("port") ?? rawTarget.sshPort,
         sshKeyPath: val("ssh-key") ?? rawTarget.sshKeyPath,
         sshOpts: val("ssh-opts") ?? rawTarget.sshOpts,
         dryRun: bool("dry-run") || !!rawTarget.dryRun,
         timeoutMs: num("timeout") ?? rawTarget.timeoutMs,
         confirm: ((): "auto" | "always" | "never" => {
            const c = val("confirm");
            return c === "always" || c === "never" ? c : (rawTarget.confirm ?? "auto");
         })(),
         extraEnv: rawTarget.extraEnv,
      };
      await uploadViaSSH(base);
      return;
   }

   if (backend === "ftp") {
      const base: RemoteFtpOpts = {
         ...(rawTarget as RemoteFtpOpts),
         host: val("host") ?? (rawTarget.host as any),
         user: val("user") ?? (rawTarget.user as any),
         password: val("pass") ?? val("password") ?? (rawTarget as RemoteFtpOpts).password ?? process.env.ZIPPER_FTP_PASS ?? "",
         domain: val("domain") ?? (rawTarget as any).domain,
         zipPath,
         webroot: val("webroot") ?? rawTarget.webroot ?? deriveWebroot(val("user") ?? rawTarget.user, val("domain") ?? (rawTarget as any).domain),
         preservePaths: split(val("preserve")) ?? rawTarget.preservePaths,
         secure: ((): any => {
            const s = val("secure");
            return (s === "none" || s === "implicit" || s === "explicit") ? s : (rawTarget as any).secure ?? "explicit";
         })(),
         port: num("port") ?? rawTarget.port ?? (((rawTarget as any).secure ?? "explicit") === "implicit" ? 990 : 21),
         dryRun: bool("dry-run") || !!rawTarget.dryRun,
         timeoutMs: num("timeout") ?? rawTarget.timeoutMs,
         concurrency: num("concurrency") ?? rawTarget.concurrency ?? 4,
         confirm: ((): "auto" | "always" | "never" => {
            const c = val("confirm");
            return c === "always" || c === "never" ? c : (rawTarget.confirm ?? "auto");
         })(),
         yes: bool("yes") || bool("force") || (rawTarget as any).yes,
      };
      await uploadViaFTP(base);
      return;
   }

   if (backend === "sftp") {
      const base: RemoteSftpOpts = {
         ...(rawTarget as RemoteSftpOpts),
         host: val("host") ?? (rawTarget.host as any),
         user: val("user") ?? (rawTarget.user as any),
         password: val("pass") ?? val("password") ?? (rawTarget as RemoteSftpOpts).password ?? process.env.ZIPPER_SFTP_PASS,
         domain: val("domain") ?? (rawTarget as any).domain,
         webroot: val("webroot") ?? rawTarget.webroot ?? deriveWebroot(val("user") ?? rawTarget.user, val("domain") ?? (rawTarget as any).domain),
         zipPath,
         preservePaths: split(val("preserve")) ?? rawTarget.preservePaths,
         port: num("port") ?? rawTarget.port ?? 22,
         dryRun: bool("dry-run") || !!rawTarget.dryRun,
         timeoutMs: num("timeout") ?? rawTarget.timeoutMs,
         concurrency: num("concurrency") ?? rawTarget.concurrency ?? 4,
         confirm: ((): "auto" | "always" | "never" => {
            const c = val("confirm");
            return c === "always" || c === "never" ? c : (rawTarget.confirm ?? "auto");
         })(),
         yes: bool("yes") || bool("force") || (rawTarget as any).yes,
      };
      await uploadViaSFTP(base);
      return;
   }

   console.log(pc.red(`[deploy] Unsupported deploy backend: ${backend}`));
   return;
}