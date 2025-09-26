// src/hooks.ts
import { spawn } from "node:child_process";
import path from "node:path";
import pc from "picocolors";
import type { HookItem, ZipConfig } from "./types.js";

export type HookPhase = "pre" | "post";

export type HookContext = {
   root: string;                 // resolved absolute root
   out?: string;                 // resolved absolute out path (post phase)
   configPath?: string;          // where we loaded .zipconfig from (if any)
   fileCount?: number;           // number of files being zipped (post phase)
   manifestPath?: string;        // external manifest path if emitted (post phase)
};

export type RunHooksOptions = {
   // extra commands from CLI
   extra?: string[];             // appended at the end of the phase
   // global defaults
   defaultTimeoutMs?: number;    // default 10m
   dryRun?: boolean;             // print but don't execute
   quiet?: boolean;              // suppress "phase start/done" lines
};

const DEFAULT_TIMEOUT = 10 * 60 * 1000;

export async function runHookPhase(
   cfg: ZipConfig,
   phase: HookPhase,
   ctx: HookContext,
   opts: RunHooksOptions = {}
) {
   const list: HookItem[] = [
      ...(cfg.hooks?.[phase] ?? []),
      ...((opts.extra ?? []) as any) // strings allowed
   ];
   if (!list.length) return;

   const label = phase === "pre" ? "pre" : "post";
   if (!opts.quiet) console.log(pc.dim(`[hooks] ${label} (${list.length})`));

   for (let i = 0; i < list.length; i++) {
      const item = normalizeHookItem(list[i]);
      const timeoutMs = item.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT;
      const cwd = item.cwd ? resolveCwd(ctx.root, item.cwd) : ctx.root;
      const { cmd, args, shell } = toCommand(item.run);

      const env = buildEnv(ctx, item.env);

      const display = shell ? cmd : [cmd, ...args].map(quote).join(" ");
      if (opts.dryRun) {
         console.log(pc.dim(`  • ${display}  (cwd=${rel(ctx.root, cwd)})`));
         continue;
      }

      console.log(pc.dim(`  • ${display}`));
      await spawnOne({ cmd, args, shell, cwd, env, timeoutMs, continueOnError: !!item.continueOnError });
   }

   if (!opts.quiet) console.log(pc.dim(`[hooks] ${label} done`));
}

function normalizeHookItem(h: HookItem): Required<Exclude<HookItem, string>> {
   if (typeof h === "string") return { run: interpolate(h), shell: true, cwd: "", timeoutMs: DEFAULT_TIMEOUT, env: {}, continueOnError: false };
   const run = Array.isArray(h.run) ? h.run.map(interpolate) : interpolate(h.run);
   return {
      run,
      shell: h.shell ?? (typeof run === "string"),
      cwd: h.cwd ?? "",
      timeoutMs: h.timeoutMs ?? DEFAULT_TIMEOUT,
      env: Object.fromEntries(Object.entries(h.env ?? {}).map(([k, v]) => [k, interpolate(v)])),
      continueOnError: !!h.continueOnError,
   };
}

function toCommand(run: string | string[]) {
   if (typeof run === "string") return { cmd: run, args: [] as string[], shell: true };
   const [cmd, ...args] = run;
   return { cmd, args, shell: false as const };
}

function spawnOne(opts: {
   cmd: string; args: string[]; shell: boolean; cwd: string;
   env: NodeJS.ProcessEnv; timeoutMs: number; continueOnError: boolean;
}) {
   return new Promise<void>((resolve, reject) => {
      const child = spawn(opts.cmd, opts.args, {
         shell: opts.shell, cwd: opts.cwd, env: opts.env, stdio: "inherit",
      });

      let killed = false;
      const t = setTimeout(() => {
         killed = true;
         child.kill("SIGTERM");
      }, Math.max(1, opts.timeoutMs));

      child.on("exit", (code) => {
         clearTimeout(t);
         if (killed) return reject(new Error(`Hook timed out after ${opts.timeoutMs}ms`));
         if (code === 0 || opts.continueOnError) return resolve();
         reject(new Error(`Hook exited with code ${code}`));
      });
      child.on("error", (err) => {
         clearTimeout(t);
         if (opts.continueOnError) return resolve();
         reject(err);
      });
   });
}

// ---------------- utils ----------------

function resolveCwd(root: string, p: string) {
   if (!p) return root;
   return path.isAbsolute(p) ? p : path.resolve(root, p);
}

function rel(root: string, p: string) {
   try { return path.relative(root, p) || "."; } catch { return p; }
}

// Token interpolation: {{root}}, {{out}}, {{config}}, {{fileCount}}, {{manifest}}
function interpolate(s: string) {
   return s
      .replace(/\{\{\s*root\s*\}\}/g, process.env.ZIPPER_ROOT ?? "")
      .replace(/\{\{\s*out\s*\}\}/g, process.env.ZIPPER_OUT ?? "")
      .replace(/\{\{\s*config\s*\}\}/g, process.env.ZIPPER_CONFIG ?? "")
      .replace(/\{\{\s*fileCount\s*\}\}/g, process.env.ZIPPER_FILE_COUNT ?? "")
      .replace(/\{\{\s*manifest\s*\}\}/g, process.env.ZIPPER_MANIFEST ?? "");
}

function buildEnv(ctx: HookContext, extra: Record<string, string> | undefined) {
   return {
      ...process.env,
      ZIPPER_ROOT: ctx.root,
      ZIPPER_OUT: ctx.out ?? "",
      ZIPPER_CONFIG: ctx.configPath ?? "",
      ZIPPER_FILE_COUNT: String(ctx.fileCount ?? ""),
      ZIPPER_MANIFEST: ctx.manifestPath ?? "",
      ...(extra ?? {})
   };
}

function quote(s: string) {
   return /\s/.test(s) ? JSON.stringify(s) : s;
}