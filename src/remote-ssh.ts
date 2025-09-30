// src/remote-ssh.ts
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { RemoteSshOpts } from "./types";

/* -----------------------------------------------------------
   Upload via SSH (runs built-in shell/upload.sh)
----------------------------------------------------------- */

export async function uploadViaSSH(opts: RemoteSshOpts) {
   const {
      host, user, domain,
      sshPort, sshKeyPath, sshOpts,
      webroot, remoteTmp,
      zipPath, backupDir, backupPrefix, backupRetain,
      preservePaths = [],
      dryRun = false,
      timeoutMs = 0,
      extraEnv = {},
      confirm = "auto",
   } = opts;

   // Fixed script path (built-in)
   const script = path.resolve(__dirname, "../shell/upload.sh");
   if (!fs.existsSync(script)) {
      throw new Error(`upload.sh not found at: ${script} (ensure it's packaged in "files")`);
   }

   // ZIP must exist for upload
   const zipAbs = path.isAbsolute(zipPath) ? zipPath : path.resolve(process.cwd(), zipPath);
   if (!fs.existsSync(zipAbs)) {
      throw new Error(`ZIP not found at: ${zipAbs}`);
   }

   // Derive sane defaults for env if not provided
   const WEBROOT = webroot ?? deriveDefaultWebroot(user ?? "", domain as string);
   const REMOTE_TMP = remoteTmp ?? deriveDefaultRemoteTmp(user ?? "");
   const BACKUP_DIR = backupDir ?? defaultBackupDir(user ?? "");
   const BACKUP_PREFIX = backupPrefix ?? `${domain}-public_html`;
   const BACKUP_RETAIN = typeof backupRetain === "number" ? String(backupRetain) : "7";

   // Prepare env consumed by the shell script
   const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(user ? { USER: user } : {}), // allow SSH alias to supply User if omitted
      HOST: host,
      DOMAIN: domain,
      ZIP_PATH: zipAbs,

      WEBROOT,
      REMOTE_TMP,
      BACKUP_DIR,
      BACKUP_PREFIX,
      BACKUP_RETAIN,

      ...(sshPort ? { SSH_PORT: String(sshPort) } : {}),
      ...(sshKeyPath ? { SSH_KEY: sshKeyPath } : {}),
      ...(sshOpts ? { SSH_OPTS: sshOpts } : {}),

      DRY_RUN: dryRun ? "1" : (process.env.DRY_RUN ?? "0"),

      // newline-separated to simplify bash parsing
      PRESERVE_NL: preservePaths.length ? preservePaths.join("\n") : "",

      ...extraEnv,
   };

   // Optional Node-side confirm to prevent accidental deploys
   const preApproved = truthy(env.YES) || truthy(env.FORCE);
   const interactive = process.stdout.isTTY && process.stdin.isTTY;

   if (confirm !== "never") {
      if (interactive && (confirm === "always" || (confirm === "auto" && !preApproved))) {
         // preview
         await printPreview({
            host,
            user: user ?? "",
            domain: domain as string,
            webroot: WEBROOT,
            remoteTmp: REMOTE_TMP,
            zipPath: zipAbs,
            dryRun: env.DRY_RUN === "1",
            backupDir: BACKUP_DIR,
            backupPrefix: BACKUP_PREFIX,
            backupRetain: Number(BACKUP_RETAIN),
            preserve: preservePaths,
         });

         const ok = await askConfirm("Proceed? [y/N] ");
         if (!ok) throw new Error("Aborted by user.");
         // Avoid duplicate prompt in script
         env.YES = env.YES ?? "1";
      } else if (!interactive && !preApproved) {
         throw new Error("Non-interactive session. Set YES=1 or FORCE=1 to proceed.");
      }
   }

   const runner = pickBashRunner(script);
   const args = runner.cmd === "bash" ? [script] : [];
   console.log(pc.dim(`[ssh] ${runner.cmd} ${args.map(quote).join(" ")}  # ${path.relative(process.cwd(), script)}`));
   console.log(pc.dim(`      HOST=${host} USER=${user ?? "(alias)"} DOMAIN=${domain} ZIP=${short(zipAbs)} DRY_RUN=${env.DRY_RUN}`));

   await spawnWithTimeout(runner.cmd, args, { cwd: process.cwd(), env, shell: runner.shell }, timeoutMs);
}

/* -----------------------------------------------------------
   Restore via SSH (runs built-in shell/restore.sh)
   Uses the SAME options shape; zipPath is ignored.
----------------------------------------------------------- */

export async function restoreViaSSH(opts: RemoteSshOpts & {
   backupName?: string;  // specific backup filename
   force?: boolean;      // skip "YES" prompt in the shell script
}) {
   const {
      host, user, domain,
      webroot, backupDir, backupPrefix,
      sshPort, sshKeyPath, sshOpts,
      dryRun = false,
      timeoutMs = 0,
      extraEnv = {},
      backupName,
      force = false,
   } = opts;

   const script = path.resolve(__dirname, "../shell/restore.sh");
   if (!fs.existsSync(script)) {
      throw new Error(`restore.sh not found at: ${script} (ensure it's packaged in "files")`);
   }

   const WEBROOT = webroot ?? deriveDefaultWebroot(user ?? "", domain as string);
   const BACKUP_DIR = backupDir ?? defaultBackupDir(user ?? "");
   const BACKUP_PREFIX = backupPrefix ?? `${domain}-public_html`;

   const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOST: host,
      USER: user ?? "",
      DOMAIN: domain,

      WEBROOT,
      BACKUP_DIR,
      BACKUP_PREFIX,
      ...(backupName ? { BACKUP_NAME: backupName } : {}),

      ...(sshPort ? { SSH_PORT: String(sshPort) } : {}),
      ...(sshKeyPath ? { SSH_KEY: sshKeyPath } : {}),
      ...(sshOpts ? { SSH_OPTS: sshOpts } : {}),

      DRY_RUN: dryRun ? "1" : (process.env.DRY_RUN ?? "0"),
      FORCE: force ? "1" : (process.env.FORCE ?? "0"),

      ...extraEnv,
   };

   const runner = pickBashRunner(script);
   const args = runner.cmd === "bash" ? [script] : [];
   console.log(pc.dim(`[ssh:restore] ${runner.cmd} ${args.join(" ")}  # ${path.relative(process.cwd(), script)}`));

   await spawnWithTimeout(runner.cmd, args, { cwd: process.cwd(), env, shell: runner.shell }, timeoutMs);
}

/* -----------------------------------------------------------
   Helpers
----------------------------------------------------------- */

function quote(s: string) { return /\s/.test(s) ? JSON.stringify(s) : s; }
function short(p: string) { return p.replace(process.cwd(), "."); }

function pickBashRunner(scriptPath: string): { cmd: string; shell: boolean } {
   if (scriptPath.toLowerCase().endsWith(".sh")) {
      const bash = process.env.BASH_PATH || "bash";
      return { cmd: bash, shell: false };
   }
   return { cmd: scriptPath, shell: true };
}

function spawnWithTimeout(cmd: string, args: string[], opts: any, timeoutMs: number) {
   return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "inherit", ...opts });

      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
         timer = setTimeout(() => {
            try { child.kill("SIGTERM"); } catch { /* noop */ }
            reject(new Error(`script timed out after ${timeoutMs}ms`));
         }, timeoutMs);
      }

      child.on("exit", (code) => {
         if (timer) clearTimeout(timer);
         if (code === 0) return resolve();
         return reject(new Error(`script exited with code ${code}`));
      });
      child.on("error", (err) => {
         if (timer) clearTimeout(timer);
         reject(err);
      });
   });
}

function truthy(v: any) {
   if (!v) return false;
   const s = String(v).toLowerCase();
   return s === "1" || s === "true" || s === "yes" || s === "y";
}

async function printPreview(info: {
   host: string;
   user: string;
   domain: string;
   webroot: string;
   remoteTmp: string;
   zipPath: string;
   dryRun: boolean;
   backupDir: string;
   backupPrefix: string;
   backupRetain: number;
   preserve: string[];
}) {
   const size = await fileSize(info.zipPath);
   const human = humanSize(size);
   console.log("");
   console.log("============ DEPLOY PREVIEW (Node) ============");
   console.log(` Target         : ${info.user ? info.user + "@" : ""}${info.host}`);
   console.log(` Webroot        : ${info.webroot}`);
   console.log(` ZIP            : ${short(info.zipPath)} (${human})`);
   console.log(` Remote tmp     : ${info.remoteTmp}`);
   console.log(` Backup         : ${info.backupDir} / ${info.backupPrefix}-<timestamp>.tar.gz`);
   console.log(` Retention      : keep latest ${info.backupRetain}`);
   console.log(` Preserve paths :`);
   for (const p of info.preserve) console.log(`   • ${p}`);
   console.log(` Delete mode    : Phase A uses rsync --delete (preserved protected)`);
   console.log(` DRY RUN        : ${info.dryRun ? "1" : "0"}`);
   console.log("===============================================");
   console.log("");
}

async function askConfirm(prompt: string) {
   const rl = createInterface({ input, output });
   try {
      const ans = await rl.question(prompt);
      return /^(y|yes)$/i.test(ans.trim());
   } finally {
      rl.close();
   }
}

async function fileSize(p: string) {
   const st = await fs.promises.stat(p);
   return st.size;
}

function humanSize(bytes: number) {
   const units = ["B", "KB", "MB", "GB", "TB"];
   let i = 0, n = bytes;
   while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
   return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function deriveDefaultWebroot(user: string, domain?: string) {
   if (!domain) throw new Error(`Missing ${pc.bold("domain")} and no webroot override provided`);
   const u = user || "user";
   return `/home/${u}/web/${domain}/public_html`;
}
function deriveDefaultRemoteTmp(user: string) {
   const u = user || "user";
   return `/home/${u}/tmp`;
}
function defaultBackupDir(user: string) {
   const u = user && user.trim() ? user : "user";
   return `/home/${u}/backups`;
}

/* -----------------------------------------------------------
   Dev CLI helpers (optional)
----------------------------------------------------------- */

export async function cli() {
   const argv = parseArgs(process.argv.slice(2)) as Record<string, string | true | undefined>;
   await uploadViaSSH({
      host: req(argv["--host"], "--host"),
      user: val(argv["--user"]),
      domain: val(argv["--domain"]),
      zipPath: req(argv["--zip"], "--zip"),

      preservePaths: split(argv["--preserve"]),
      backupDir: val(argv["--backup-dir"]),
      backupPrefix: val(argv["--backup-prefix"]),
      backupRetain: argv["--backup-retain"] ? Number(argv["--backup-retain"]) : undefined,
      webroot: val(argv["--webroot"]),
      remoteTmp: val(argv["--remote-tmp"]),
      sshPort: argv["--ssh-port"] ? Number(argv["--ssh-port"]) : undefined,
      sshKeyPath: val(argv["--ssh-key"]),
      sshOpts: val(argv["--ssh-opts"]),
      dryRun: !!argv["--dry-run"],
      timeoutMs: argv["--timeout"] ? Number(argv["--timeout"]) : 0,
      confirm: ((): "auto" | "always" | "never" => {
         const c = val(argv["--confirm"]);
         return c === "always" || c === "never" ? c : "auto";
      })(),
      extraEnv: {
         ...(argv["--yes"] ? { YES: "1" } : {}),
         ...(argv["--force"] ? { FORCE: "1" } : {}),
      },
   });
}

export async function cliRestoreSSH() {
   const a = parseArgs(process.argv.slice(2)) as any;
   await restoreViaSSH({
      host: req(a["--host"], "--host"),
      user: req(a["--user"], "--user"),
      domain: a["--domain"],
      webroot: a["--webroot"],
      backupDir: a["--backup-dir"],
      backupPrefix: a["--backup-prefix"],
      backupName: a["--backup-name"],
      sshPort: a["--ssh-port"] ? Number(a["--ssh-port"]) : undefined,
      sshKeyPath: a["--ssh-key"],
      sshOpts: a["--ssh-opts"],
      dryRun: !!a["--dry-run"],
      force: !!a["--yes"],
      timeoutMs: a["--timeout"] ? Number(a["--timeout"]) : 0,

      // Same shape as RemoteSshOpts; zipPath is not used here, but keep shape consistent.
      zipPath: a["--zip"] ?? ".",
   });
}

/* tiny arg parser */
function parseArgs(xs: string[]) {
   const out: Record<string, string | true> = {};
   for (let i = 0; i < xs.length; i++) {
      const t = xs[i];
      if (t.startsWith("--")) {
         if (i + 1 < xs.length && !xs[i + 1].startsWith("--")) out[t] = xs[++i];
         else out[t] = true;
      }
   }
   return out;
}
function req(v: any, flag: string) {
   if (!v) throw new Error(`Missing ${flag}`);
   return v as string;
}
function val(v: any) {
   return typeof v === "string" ? v : undefined;
}
function split(v: any): string[] | undefined {
   if (!v) return undefined;
   return String(v).split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}