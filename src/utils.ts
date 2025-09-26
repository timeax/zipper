import os from 'node:os';
import path from "node:path";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
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

// src/util-istext.ts
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".html", ".htm", ".xml", ".json", ".yaml", ".yml",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".less",
  ".py", ".rb", ".php", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".go", ".rs",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".ini", ".toml", ".conf",
  ".csv", ".tsv", ".svg", ".map",
]);

/**
 * Heuristic: treat as text if
 *  - extension looks textual, OR
 *  - sample bytes contain no NULs and < ~5% suspicious control bytes.
 * UTF-8 BOM is allowed.
 */
export function isText(buf: Buffer, filename?: string): boolean {
  const ext = filename ? getExt(filename) : "";
  if (TEXT_EXT.has(ext)) return true;

  const len = Math.min(buf.length, 4096); // small sample is enough
  if (len === 0) return true;

  // UTF-8 BOM?
  if (len >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return true;

  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const byte = buf[i];

    // NUL byte → very likely binary
    if (byte === 0) return false;

    // Allow common whitespace/control: \n \r \t \f \v \b
    if (
      byte === 0x0A || byte === 0x0D || byte === 0x09 ||
      byte === 0x0C || byte === 0x0B || byte === 0x08
    ) continue;

    // Most ASCII printable range
    if (byte >= 0x20 && byte <= 0x7E) continue;

    // Extended UTF-8 bytes (>= 0x80) — often text
    if (byte >= 0x80) continue;

    // Remaining C0 controls (0x01–0x1F minus ones above) → suspicious
    suspicious++;
  }

  // If too many odd control bytes, call it binary
  return suspicious / len <= 0.05; // <= 5% suspicious bytes
}

function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** Name used by cosmiconfig for search (".zipconfig", "package.json" → { zipper: {...} }) */
export const MODULE_NAME = "zipper";

/**
 * If a config path has no extension and isn’t a dotfile, assume it's a stub name and append ".stub".
 * Examples:
 *   "laravel"        -> "laravel.stub"
 *   "inertia.stub"   -> "inertia.stub"
 *   ".zipconfig"     -> ".zipconfig"   (dotfile, leave as-is)
 *   "zip.json"       -> "zip.json"     (has ext, leave as-is)
 */
export function appendStubIfNoExt(input: string): string {
  const base = path.basename(input);
  // explicit known extensions → leave alone
  if (/\.(stub|json|ya?ml)$/i.test(base)) return input;
  // dotfiles like ".zipconfig" → leave alone
  if (base.startsWith(".")) return input;
  // anything with an ext → leave alone
  if (path.extname(base)) return input;
  // otherwise assume stub
  return input.endsWith(".stub") ? input : input + ".stub";
}

/**
 * Parse a config file whose format is unknown (YAML or JSON).
 * YAML parser handles JSON too, so prefer YAML here.
 * Returns the parsed object (if the file was `package.json`, the caller can
 * still do `obj.zipper ?? obj` as needed).
 */
export function parseUnknownConfig(content: string): any {
  try {
    // YAML.parse can parse JSON; this keeps comments & YAML features working.
    return YAML.parse(content);
  } catch {
    // last resort
    try { return JSON.parse(content); }
    catch { return {}; }
  }
}

/**
 * Expand environment variables and ~ in simple paths/strings.
 * Supports:
 *   - ${VAR} and $VAR
 *   - leading "~" → user home
 */
export function envExpand(input: string | undefined): string {
  if (!input) return "";
  let s = String(input);

  // Expand ${VAR}
  s = s.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  // Expand $VAR (avoid $$ or $ followed by non-identifier)
  s = s.replace(/(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? "");

  // Leading ~ → home
  if (s.startsWith("~")) {
    s = path.join(os.homedir(), s.slice(1));
  }

  return s;
}