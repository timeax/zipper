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

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Add/update stubs or presets
4. Run tests (`npm test`)
5. Submit a PR

---

## 📜 License

MIT © Timeax
