# Zipper

A flexible project archiver and configuration‑based zipping tool. Define what goes into your archives with a simple `.zipconfig` file, **stubs**, **presets**, **groups**, and **preprocess hooks**. First‑class workflows for Laravel, Node, and Inertia projects.

---

## ✨ Features

* **Config‑driven**: `.zipconfig` (YAML/JSON) controls include/exclude, presets, output, etc.
* **Stubs**: Ready‑made config templates (e.g. `laravel.stub`, `node.stub`, `inertia.stub`).
* **Built‑ins always available**: The CLI **always** searches bundled stubs in the package, in addition to local and global.
* **Presets**: Reusable include/exclude bundles (built‑in + user presets).
* **Groups**: Map matched files into virtual folders in the archive (e.g. `src/`, `web/`, `docs/`).
* **Preprocess (JS/TS)**: Run transform callbacks on matched files **at pack time** without touching source.
* **Diagnostics**: `preprocess doctor` to validate modules and preview changes.
* **Interactive UX**: TUI pickers for migrating presets and selecting stubs.
* **CLI niceties**: `pack` (with `build` alias), dry‑run, `--list` (final zip paths), respect `.gitignore`, manifest emit, list files from `--from`.
* **Cross‑platform**: Linux, macOS, Windows.

---

## 📦 Installation

```bash
npm install -g @timeax/zipper
```

Local (per‑project):

```bash
npm install --save-dev @timeax/zipper
```

---

## 🚀 Quick Start

```bash
# 1) Create a config from a stub (auto‑discovers local, global, and built‑in stubs)
zipper init laravel

# 2) Preview what will be packed (scanner output)
zipper pack --dry-run

# 3) Create the archive
zipper pack --out dist/project.zip
```

> Prefer `pack` (similar to `npm pack`). `build` remains as a hidden alias for convenience.

---

## 🛠 Usage

### Init a config from stubs

```bash
# Non‑interactive by name
zipper init laravel

# Interactive menu (shows Local / Global / Built‑in)
zipper init --interactive

# Use a local stubs folder explicitly (if you’re inside ./stubs, use --dir .)
zipper init inertia --dir stubs
```

**Stub resolution order**: Local `./stubs/` → Global dir(s) → **Built‑in** (always checked).

### Pack an archive

```bash
zipper pack [options]
```

Common flows:

```bash
zipper pack --out ./dist/my-app.zip
zipper pack --config ./custom-config.yml
zipper pack --config laravel        # resolves laravel.stub (local→global→built‑in)
zipper pack --dry-run               # print pre-zip selection (scanner output)
zipper pack --list                  # print final zip paths (after groups + preprocess)
```

All options:

* `--config <path>`: Path to config file. If no extension, `.stub` is assumed and resolved via Local/Global/Built‑in.
* `--out <path>`: Output zip path (overrides config field).
* `--include <globs...>`: Extra include globs.
* `--exclude <globs...>`: Extra exclude globs.
* `--order <string>`: Rule order; `include,exclude` (default) or `exclude,include`.
* `--root <path>`: Project root for scanning.
* `--dry-run`: Print file list **before** grouping/preprocess.
* `--list`: Print final **zip paths** (after groups + preprocess) and exit.
* `--group <names...>`: Only include these group(s) by name.
* `--respect-gitignore`: Also exclude files from `.gitignore`.
* `--from <path>`: Read additional paths (one per line) from a file.
* `--ignore-file <paths...>`: Extra ignore files (defaults include `.zipignore`).
* `--no-manifest`: Disable manifest emission.
* `--manifest-path <path>`: Write manifest to an external path.
* **Preprocess flags**: `--no-preprocess`, `--strict-preprocess`, `--preprocess-timeout <ms>`, `--preprocess-max-bytes <n>`, `--preprocess-binary-mode <skip|pass|buffer>`, `--preprocess <modules...>` (adds modules in addition to config).

Alias:

```bash
zipper build [options]
```

---

## 📑 `.zipconfig` format (YAML/JSON)

Minimal:

```yaml
# .zipconfig
include:
  - app/**
  - config/**
exclude:
  - node_modules/**
  - vendor/**
presets:
  - laravel-basic
out: dist/project.zip
respectGitignore: true
order: [exclude, include]  # let includes punch holes back in
```

### Groups (virtual folders in the zip)

```yaml
# Map matched files into folders inside the archive
groups:
  backend:
    target: src/
    include: ["app/**", "config/**"]
    exclude: ["app/Debug/**"]
    priority: 10  # higher wins when multiple groups match

  frontend:
    target: web/
    include: ["resources/js/**", "resources/css/**", "public/**"]
    files: ['resources/views/index.blade.php'] # included as web/index.blade.php
    priority: 5

  docs:
    target: docs/
    include: ["README.md", "docs/**"]
```

* Files matching a group are placed under its `target` path inside the zip.
* If multiple groups match, **higher `priority` wins**; ties are resolved by later‑defined groups.
* Files that match **no group** are kept at their original relative path.
* Use `--group name` to include only specific groups.

### Preprocess (JS/TS modules only)

> JS/TS files are **not** full configs; they only export preprocess handlers. Reference them from YAML/JSON via `preprocess.modules`.

```yaml
preprocess:
  modules:
    - ./zip.preprocess.ts
    - ./more-hooks.js
  includes: ["**/*.html", "**/*.js"]      # which files should be considered for preprocess
  excludes: ["**/*.min.js"]
  files: ["README.md"]                      # explicit additions
  maxBytes: 5242880                           # skip preprocess for files larger than this (still included)
  binaryMode: pass                            # skip | pass | buffer
  timeoutMs: 10000
```

**Module shape** (`zip.preprocess.ts`):

```ts
import type { PreprocessHandler } from '@timeax/zipper';

export const handlers: PreprocessHandler[] = [
  ({ stats, content, ctx }) => {
    if (stats.ext !== '.html' && stats.ext !== '.js') return;
    let s = content.toString('utf8')
      .replaceAll('__APP__', ctx.env.APP_NAME ?? 'ZipperApp')
      .replaceAll('__BUILD__', ctx.buildId);
    return Buffer.from(s, 'utf8');
  },
  ({ stats }) => (stats.name.endsWith('.log') && stats.size > 128 * 1024 ? null : undefined),
];

export default handlers; // default or named export both supported
```

---

## 📂 Stubs (manage templates)

Zipper ships with built‑in stubs (e.g. `laravel.stub`, `node.stub`, `inertia.stub`). You can also keep:

* **Local**: `./stubs/`
* **Global**: `~/.config/zipper/stubs/` (Windows: `%USERPROFILE%\.config\zipper\stubs` or `%USERPROFILE%\.zipper\stubs`)

**Commands (grouped):**

```bash
# List local / global / built‑in
zipper stub ls

# Print a stub to stdout (name optional → interactive picker)
zipper stub cat              # picker
zipper stub cat laravel      # by name

# Copy a stub file to a destination (creates dirs; use --force to overwrite)
zipper stub cp laravel ./.zipconfig          
zipper stub cp inertia ./stubs/inertia.stub  

# Add an existing file into your global stubs
zipper stub add stubs/custom.stub --to ~/.config/zipper/stubs
```

> If you are **inside** the `stubs/` directory, use `--dir .` when targeting local stubs.

---

## 🧩 Presets (reusable rule bundles)

Use presets to avoid repeating include/exclude rules across projects.

Built‑in presets:

* `laravel-basic`
* `laravel-no-vendor`
* `node-module`
* `inertia`

**Commands (grouped):**

```bash
# Discover & inspect
zipper preset ls
zipper preset show laravel-basic --format yaml

# Create from a config/stub or ad‑hoc
zipper preset add my-company.laravel --from .zipconfig
zipper preset add node-ci --include dist/** --exclude tests/**

# Export / import
zipper preset export laravel-basic --to laravel-basic.yml
zipper preset import inertia-prod --from stubs/inertia-prod.stub

# Rename / remove
zipper preset rename old-name new-name
zipper preset rm my-company.laravel

# Migrate in bulk (interactive picker by default)
zipper preset migrate --include-globals
zipper preset migrate --all          # non‑interactive (select all)
zipper preset migrate --all --dry-run
```

**Merge order** (later wins):

1. Defaults → 2) **Presets** (listed order) → 3) `.zipconfig` → 4) **CLI flags**

If two rules conflict, `order` determines who can re‑include:

* `order: [include, exclude]` (default): excludes win last
* `order: [exclude, include]`: includes can re‑add specifics

---

## 🧭 Groups UX

```bash
# List groups with targets, priority, and sample matches
zipper group ls

# Restrict scan for examples
zipper group ls --glob "app/**" --glob "resources/**" --limit 10 --verbose

# Pack only certain groups
zipper pack --group backend --group docs --list
```

---

# 📂 Groups, Includes, and Excludes

This section explains exactly how **groups** interact with base `include`, `exclude`, and `files` rules in Zipper.

---

## 1. Selection (what files enter the pipeline)

* Start with files matching base **`include`** (or `**/*` if none).
* Remove anything matching base **`exclude`** and `.gitignore` (if enabled).
* Apply **`order`**:

  * `include,exclude` (default): excludes win last.
  * `exclude,include`: includes “punch through” at the end.
* **Special case**: `groups.*.files` are always added, even if not in base `include`.

📌 At this stage, `groups.*.include` and `groups.*.exclude` are **ignored**. They never filter what exists — they only matter later for mapping.

---

## 2. Group claim (who owns a file)

* For each file from selection:

  * A group claims it if:

    * It appears in **`groups.<name>.files`** (exact path), or
    * It matches the group’s `include` globs and not the group’s `exclude` globs.
* Conflicts:

  * Higher **`priority`** wins.
  * Equal priority → later-defined group wins.
* If no group claims it → file stays ungrouped.

📌 `groups.*.exclude` only prevents that group from claiming the file. It does not remove the file from the archive.

---

## 3. Mapping (how paths are rewritten)

* **Via `files`:** placed as `target + basename(file)` (parents dropped).
* **Via `include` globs:** placed as `target + original/relative/path`.
* **Ungrouped files:** keep their original relative path.
* `target` rules:

  * `""` → archive root.
  * `"public/"` → inside a `public` folder in the zip.

---

## 4. Preprocess (optional, after grouping)

* Runs per file (source path + zip path + buffer).
* Handler may:

  * return new content → replace bytes,
  * return new zipPath → move it,
  * return `null` → drop it,
  * return nothing → pass through unchanged.
* Strict mode (`--strict-preprocess`) fails on error; otherwise errors are logged.

---

## 5. Collisions (same zipPath twice)

If two files map to the same zipPath:

* Default: **last one wins**.
* Recommended: log a warning (source A → replaced by source B).
* Future policies can be: fail-fast, or auto-rename with suffix/hash.

---

## ✅ Guarantees

* Base `include`/`exclude` still apply even when groups are defined.
* `groups` never erase base rules; they only:

  * add exact `files`,
  * decide who *claims* an existing file,
  * and rewrite its archive path.
* Counts:

  * `Scanner count (dry-run)` = `Post-group count` (unless preprocess drops some).

---

## Example

```yaml
include:
  - app/**
  - resources/**
exclude:
  - node_modules/**
  - vendor/**
order: [exclude, include]

groups:
  server:
    target: "server/"
    include: ["app/**"]
  web:
    target: "public/"
    files:
      - resources/views/index.blade.php
```

Result:

* `app/Models/User.php` → `server/app/Models/User.php`
* `resources/views/index.blade.php` → `public/index.blade.php`
* `resources/css/app.css` → stays as `resources/css/app.css` (no group claim)
* `vendor/…` → excluded.


---

## 🧪 Preprocess diagnostics

```bash
# Validate modules + run a small test set
zipper preprocess doctor

# Add extra modules from CLI and limit to globs
zipper preprocess doctor --preprocess ./zip.preprocess.ts --glob "resources/**/*.js" --limit 8

# Fail on handler errors/timeouts
zipper preprocess doctor --strict-preprocess
```

---

## 🎮 Interactive demos

### Preset multi‑select (migrate)

```text
$ zipper preset migrate --include-globals

Select files to migrate into user presets
Use ↑/↓, space to toggle, 'a' = toggle all, Enter to confirm

> [x] laravel.stub        ./stubs
  [ ] inertia.stub        ./stubs
  [x] node.stub           ./stubs

2/3 selected
```

### Dry‑run preview

```text
$ zipper pack --dry-run

# Config: .zipconfig  Root: ./
app/Http/Controllers/UserController.php
app/Models/User.php
config/app.php
...

152 files selected.
```

### Final zip path preview (after groups + preprocess)

```text
$ zipper pack --list
web/resources/js/app.js
src/app/Models/User.php
docs/README.md
...
```

---

## 🌍 Global locations

* Presets: `~/.config/zipper/presets`
* Stubs:   `~/.config/zipper/stubs`

Environment overrides:

```bash
export ZIPPER_PRESETS="$HOME/dev/zipper-presets"
export ZIPPER_STUBS="$HOME/dev/zipper-stubs"
```

Windows PowerShell:

```powershell
$env:ZIPPER_PRESETS = "$HOME\.zipper\presets"
$env:ZIPPER_STUBS   = "$HOME\.zipper\stubs"
```

---

## 📘 Notes

* Built‑in stubs are **always** checked; you can reference them by base name (e.g. `laravel`).

* When `respectGitignore` is enabled, `.gitignore` rules are applied as **excludes**.

* By default, the order is `[include, exclude]` → excludes win.

* To allow includes to override `.gitignore`, set:

  ```yaml
  order: [exclude, include]
  ```

* This ensures you can re‑include specific files or folders even if ignored by Git.

---

## 📹 GIF workflows (optional)

Suggested tools:

* **asciinema** → lightweight, shareable casts: [https://asciinema.org/](https://asciinema.org/)
* **terminalizer** → GIFs from scripts: [https://github.com/faressoft/terminalizer](https://github.com/faressoft/terminalizer)

Suggested script:

1. `zipper stub ls`
2. `zipper init laravel`
3. `zipper pack --dry-run`
4. `zipper preset migrate --include-globals`
5. `zipper pack --out dist/app.zip`

---

# 🔄 Update Notes — CLI Additions & Behavior Changes

## New: Pre/Post Hook Commands

You can now run custom commands **before** and/or **after** packaging.

### `.zipconfig`

```yaml
hooks:
  pre:
    - "npm ci"
    - "npm run build"
    - run: ["php", "artisan", "config:cache"]
      timeoutMs: 120000
  post:
    - run: "node scripts/after-pack.js {{out}}"
      continueOnError: true
      env:
        CHANNEL: "ci"
```

**Tokens available in hooks**

* `{{root}}`, `{{out}}`, `{{config}}`, `{{fileCount}}`, `{{manifest}}`
  …also exposed as env vars: `ZIPPER_ROOT`, `ZIPPER_OUT`, `ZIPPER_CONFIG`, `ZIPPER_FILE_COUNT`, `ZIPPER_MANIFEST`.

**CLI controls**

* `--no-hooks` — disable hooks entirely
* `--pre "<cmd>"` — append an extra **pre** hook (repeatable)
* `--post "<cmd>"` — append an extra **post** hook (repeatable)
* `--hook-timeout <ms>` — default per-command timeout
* `--hooks-dry-run` — print what would run, don’t execute

> Hooks are cross-platform: strings run via the shell, arrays run as raw `[cmd, ...args]`.

---

## New: Smart-Merge Progress & Timing

**Smart-merge** now has optional progress and timings to help diagnose slow projects.

**Environment toggles**

* `ZIPPER_SMARTMERGE_PROGRESS=1` — show a progress bar while resolving effective file list
* `ZIPPER_DEBUG=1` — also enables smart-merge progress
* `ZIPPER_TIMING=1` — end-to-end phase timings (loadConfig, buildFileList, writeZip, etc.)

Example:

```bash
ZIPPER_TIMING=1 ZIPPER_SMARTMERGE_PROGRESS=1 zipper pack --dry-run
```

You’ll see logs like:

```
[smart-merge] [cfg] sources: 3 tier(s) in 2ms
[smart-merge] [cfg] scan: 12690 candidates … in 240ms
████████████████████████████████ 100% | 12690/12690
[smart-merge] [cfg] decide: kept 4311 / 12690 in 190ms
[timing] buildFileList: 15ms
```

---

## Faster Packing (No Globbing on Materialized Includes)

When smart-merge is enabled, `cfg.include` is now a **final explicit list** of files.
The packer skips `globby()` entirely and just:

1. de-dupes includes + `--from` list,
2. applies ignore rules,
3. re-adds items if `order: [exclude, include]`,
4. sorts if `deterministic: true`.

This removes large startup stalls on big repos.

---

## Pack Enhancements (Flags)

New/clarified flags on `zipper pack`:

* `--group <name>` (repeatable) — select only the named groups from `.zipconfig`
* `--no-preprocess` — disable preprocess pipeline
* `--strict-preprocess` — fail the build on preprocess errors
* `--preprocess <module...>` — load extra preprocess modules (ts/js)
* `--preprocess-timeout <ms>` — per-file preprocess timeout
* `--preprocess-max-bytes <n>` — cap file size fed to preprocess
* `--preprocess-binary-mode <skip|pass>` — behavior for binaries in preprocess

(These layer on top of whatever is defined in `.zipconfig`.)

---

## Usability Tweaks

* `zipper stub cat` — **name is optional**; omitting it opens an interactive picker (Local / Global / Built-in).
* `zipper group ls` — shows each group’s target, priority, and sample mappings; supports `--glob` limiter and `--limit` for previews.

---

## Backwards Compatibility

* No breaking changes to existing `.zipconfig` files.
* Hooks are additive; if not specified, nothing runs.
* The selection algorithm is unchanged in outcome; it’s just faster and more transparent.

---

## Security Notes (Hooks)

* Treat hook commands as trusted code (they run with your user permissions).
* Prefer checked-in scripts over inline shell when sharing configs.
* Consider `continueOnError: true` for non-critical post steps (like notifications).

---

## Quick Examples

Run with hooks disabled:

```bash
zipper pack --no-hooks
```

Append an extra post step (e.g., upload the artifact):

```bash
zipper pack --post "node scripts/upload.js {{out}}"
```

Diagnose performance:

```bash
ZIPPER_TIMING=1 zipper pack --dry-run
```
---

# Remote Deploy & Restore (Beta)

This update adds first‑class **remote deployment** and **restore** flows to Zipper. You can deploy the zip you just built to a server via:

* **SSH (shell/rsync)** — runs `shell/upload.sh` on your server user, with preserve & backup logic.
* **SFTP** — upload via SFTP, with preserve/merge behavior.
* **FTP/FTPS** — upload via FTP (explicit/implicit TLS), with preserve/merge behavior.

There are also matching **restore** flows to roll back from backups.

---

## Quick start

1. Add a `deploy` block to your `.zipconfig` (JSON/YAML/JS), for one or more backends.

```yaml
# .zipconfig (YAML)
out: dist/build.zip

# … your regular zipper config …

deploy:
  default: sftp   # optional; if omitted the first configured target is used
  targets:
    sftp:
      host: 203.0.113.10
      user: deploy
      domain: example.com           # used to infer webroot if not set
      # webroot: /home/deploy/web/example.com/public_html
      preservePaths: [uploads/, storage/, .well-known/, robots.txt]
      timeoutMs: 120000

    ftp:
      host: ftp.example.com
      user: deploy@example.com
      password: ${FTP_PASS}
      webroot: /httpdocs
      secure: explicit               # "explicit" | "implicit" | "none"

    shell:
      host: 203.0.113.20
      user: app
      domain: app.example.com
      # webroot/backupDir can be inferred; override if custom
```

2. Build and deploy in one go:

```bash
# Build then deploy to the default/first target
zipper pack --remote

# Or pick a target explicitly (overrides deploy.default)
zipper pack --remote --target sftp
```

You can also deploy/restore independently:

```bash
# Upload (by target)
zipper upload:sftp
zipper upload:ftp
zipper upload:shell

# Upload (auto-select default/first)
zipper upload                # uses deploy.default or first configured
zipper upload --target ftp   # override

# Restore (by target)
zipper restore:sftp --remote-dir /home/deploy/backups --remote-prefix example.com-public_html
zipper restore:ftp  --backup backups/example.com-public_html-20250101-000000.tar.gz
zipper restore:shell --backup-name app.example.com-public_html-20250101-000000.tar.gz

# Restore (auto-select)
zipper restore               # uses deploy.default or first configured
zipper restore --target shell
```

---

## Command reference

### Build + deploy

```bash
zipper pack --remote [--target <shell|sftp|ftp>] [common flags…]
```

* Uses your regular `pack` options **and** forwards relevant remote flags.
* Selects target by `--target`, else `deploy.default`, else first configured.

### Upload only

Shortcuts for each backend:

```bash
zipper upload:shell [flags]
zipper upload:sftp  [flags]
zipper upload:ftp   [flags]
```

Target‑agnostic:

```bash
zipper upload [--target <shell|sftp|ftp>] [flags]
```

### Restore

```bash
zipper restore:shell [--backup-name <file>]
zipper restore:sftp  [--backup <local>] [--remote-dir <path>] [--remote-prefix <p>] [--remote-name <file>]
zipper restore:ftp   --backup <local .zip|.tar.gz>

# Or auto-select target
zipper restore [--target <shell|sftp|ftp>] [flags]
```

> **Notes on backups**
>
> * **shell (SSH)**: `upload.sh` always creates a remote tar.gz backup of `public_html` before syncing. `restore.sh` restores from that remote backup directory and supports `--backup-name`.
> * **sftp**: Restore supports **either** a local archive path **or** pulling from a remote backup directory by prefix/name.
> * **ftp**: Restore uses a **local** archive you provide.

---

## Options (common)

* `--yes` / `--confirm=never|always|auto` — control interactive confirmation (default `auto`). Non‑interactive requires `--yes`.
* `--dry-run` — preview without changing remote.
* `--timeout <ms>` — connection/operation timeout (default inherits sensible backend default).
* `--concurrency <n>` — parallel uploads (SFTP/FTP; default `4`, max `16`).
* `--preserve a,b,c` — override/extend `preservePaths` from config. Paths ending with `/` are treated as directory prefixes; exact filenames otherwise.

### Target‑specific flags (when you need to override config)

**SSH (shell)**

```
--host <ip/alias>  --user <name>  --domain <example.com>
--webroot <abs path>  --backup-dir <abs>  --backup-prefix <str>  --backup-retain <N>
--ssh-key <path>  --ssh-port <22>  --ssh-opts "-o StrictHostKeyChecking=accept-new"
```

**SFTP**

```
--host --user --pass <or ZIPPER_SFTP_PASS> --port <22>
--webroot <abs>  --domain <example.com>   # if webroot omitted, domain+user => /home/<user>/web/<domain>/public_html
```

**FTP/FTPS**

```
--host --user --pass <or ZIPPER_FTP_PASS> --secure <explicit|implicit|none> --port <21|990>
--webroot <abs>  # required (no domain inference for raw FTP)
```

---

## How “preserve” & sync work

The deployers run in **two phases**:

1. **Phase A (authoritative)** — outside preserved paths, delete remote files not present in the release, then upload/update non‑preserved files.
2. **Phase B (merge)** — inside preserved paths, **only add new files** (do not overwrite or delete). Useful for `uploads/`, `storage/`, etc.

Preserve matching:

* `"uploads/"` → treats `uploads/` as a directory prefix.
* `"robots.txt"` → exact file match.

---

## Webroot & domain inference

* **shell (SSH)** and **sftp** can infer `webroot` as:

```
/home/<user>/web/<domain>/public_html
```

…when `domain` is provided in config/flags and `webroot` is omitted.

* **ftp** requires `webroot` explicitly (no inference).

---

## Configuration

You can place deploy settings under `deploy.targets` in `.zipconfig`. Examples:

### Minimal SFTP

```jsonc
{
  "out": "dist/build.zip",
  "deploy": {
    "default": "sftp",
    "targets": {
      "sftp": {
        "host": "203.0.113.10",
        "user": "deploy",
        "domain": "example.com",          // webroot inferred
        "preservePaths": ["uploads/", "storage/", ".well-known/", "robots.txt"],
        "timeoutMs": 120000
      }
    }
  }
}
```

### FTP with FTPS (explicit)

```jsonc
{
  "out": "dist/build.zip",
  "deploy": {
    "targets": {
      "ftp": {
        "host": "ftp.example.com",
        "user": "deploy@example.com",
        "password": "${FTP_PASS}",
        "webroot": "/httpdocs",
        "secure": "explicit"
      }
    }
  }
}
```

### SSH (shell) using `shell/upload.sh`

```jsonc
{
  "out": "dist/build.zip",
  "deploy": {
    "targets": {
      "shell": {
        "host": "203.0.113.20",
        "user": "app",
        "domain": "app.example.com",
        "preservePaths": ["uploads/", "storage/"],
        "sshKeyPath": "~/.ssh/id_ed25519"
      }
    }
  }
}
```

> The shell backend maps settings to environment variables read by `shell/upload.sh` / `shell/restore.sh` (e.g., `HOST`, `USER`, `DOMAIN`, `ZIP_PATH`, `BACKUP_DIR`, `BACKUP_PREFIX`, `BACKUP_RETAIN`, `YES`, `DRY_RUN`, etc.). You can still override values via CLI flags.

---

## Build hooks + remote

You can keep custom steps in hooks and still use the remote deploy:

```yaml
hooks:
  pre:
    - "pnpm build"
  post:
    - run: ["node", "scripts/ping.js"]
```

```bash
zipper pack --remote --target sftp
```

Hooks run locally **before** upload.

---

## Restore examples

**shell (SSH)** — restore the latest (server‑side backups created by `upload.sh`):

```bash
zipper restore:shell                   # pick latest by name
zipper restore:shell --backup-name app.example.com-public_html-20250101-000000.tar.gz
```

**sftp** — restore from a local backup or fetch from a remote backup dir:

```bash
# local archive
zipper restore:sftp --backup backups/site-20250101-000000.tar.gz

# pick the most recent on the server by prefix
zipper restore:sftp --remote-dir /home/deploy/backups --remote-prefix example.com-public_html

# or name it explicitly
zipper restore:sftp --remote-dir /home/deploy/backups --remote-name example.com-public_html-20250101-000000.tar.gz
```

**ftp** — restore from a local backup archive:

```bash
zipper restore:ftp --backup backups/site-20250101-000000.zip
```

All restore commands accept common flags like `--yes`, `--dry-run`, `--timeout`, `--preserve`, etc.

---

## Non‑interactive runs (CI)

Add `--yes` (or env `YES=1`) to bypass prompts. Example:

```bash
YES=1 zipper pack --remote --target sftp
```

---

## Troubleshooting

* **“Non-interactive session. Pass --yes …”** — Add `--yes` or set `YES=1` in CI.
* **SSH: Permission denied (publickey)** — Ensure your key is loaded (`ssh-add -l`) and the server user has shell access (not SFTP‑only). The scripts use `StrictHostKeyChecking=accept-new` by default.
* **FTP TLS issues** — Try `--secure implicit` (port 990) or `--secure none` for plain FTP (not recommended). Some hosts require passive mode by default (handled by the client).
* **Wrong webroot** — For shell/sftp, set `domain` or override `webroot`. For FTP you must set `webroot` explicitly.
* **Preserve paths overwriting files** — Only new files are added in preserved paths; existing files are not overwritten in Phase B.

---

## Security

* Prefer **SSH/SFTP** over FTP where possible.
* Store secrets in env vars (e.g., `ZIPPER_FTP_PASS`, `ZIPPER_SFTP_PASS`) and reference them in `.zipconfig`.
* Limit the deploy user’s permissions to just the docroot.

---

## FAQ

**Q: Do I have to put `zipPath` in the config?**
A: Not for `pack --remote` — it uses the freshly built `out` file. For direct uploads (`zipper upload:*`) you can pass `--zip` to override.

**Q: What’s the default target if I don’t pass `--target`?**
A: `deploy.default` if set, otherwise the first configured target under `deploy.targets`.

**Q: Can I run my own scripts?**
A: Yes — use **hooks** locally, or the **shell** backend which executes our `shell/*.sh` scripts on the server. You can still extend those scripts as needed.

---

Happy shipping! 🚀

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Add/update stubs or presets
4. Run tests (`npm test`)
5. Submit a PR

---

## 📜 License

MIT © Timeax
