import os from 'node:os';
import path from "node:path";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";

/** Get global stub dirs:
 * Priority: explicit --global-dir(s) > ZIPPER_STUBS env (split by path delimiter) > defaults (~/.config/zipper/stubs, ~/.zipper/stubs)
 */
export function getGlobalStubDirs(extra: string[] = []): string[] {
   const fromFlag = extra.filter(Boolean);
   const envRaw = process.env.ZIPPER_STUBS || "";
   const sep = path.delimiter; // ':' POSIX, ';' Windows
   const fromEnv = envRaw.split(sep).map(s => s.trim()).filter(Boolean);

   const home = os.homedir();
   const defaults = [
      path.join(home, ".config", "zipper", "stubs"),
      path.join(home, ".zipper", "stubs"),
   ];

   const all = [...fromFlag, ...fromEnv, ...defaults];
   // unique + existing dirs only
   const seen = new Set<string>();
   const out: string[] = [];
   for (const d of all) {
      const abs = path.isAbsolute(d) ? d : path.resolve(process.cwd(), d);
      if (!seen.has(abs) && isDirSync(abs)) {
         seen.add(abs);
         out.push(abs);
      }
   }
   return out;
}

function isDirSync(p: string) {
   try { return fsSync.statSync(p).isDirectory(); } catch { return false; }
}


// Where the package’s own stubs live (bundled with the lib)
export function getBuiltinStubDir(): string {
  // ../stubs relative to this compiled file
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../stubs");
}