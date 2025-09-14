# Zipper

A flexible project archiver and configuration‑based zipping tool. Define what goes into your archives with a simple `.zipconfig` file, **stubs**, and **presets**. First‑class workflows for Laravel, Node, and Inertia projects.

---

## ✨ Features

* **Config‑driven**: `.zipconfig` (YAML/JSON) controls include/exclude, presets, output, etc.
* **Stubs**: Ready‑made config templates (e.g. `laravel.stub`, `node.stub`, `inertia.stub`).
* **Built‑ins always available**: The CLI **always** searches bundled stubs in the package, in addition to local and global.
* **Presets**: Reusable include/exclude bundles (built‑in + user presets).
* **Global stubs & presets**: Keep your organization defaults under `~/.config/zipper/`.
* **Interactive UX**: TUI pickers for migrating presets and selecting stubs.
* **CLI niceties**: `pack` (with `build` alias), dry‑run, respect `.gitignore`, manifest emit, list files from `--from`.
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

# 2) Preview what will be packed
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
zipper pack --dry-run               # print final file list
```

All options:

* `--config <path>`: Path to config file. If no extension, `.stub` is assumed and resolved via Local/Global/Built‑in.
* `--out <path>`: Output zip path (overrides config field).
* `--include <globs...>`: Extra include globs.
* `--exclude <globs...>`: Extra exclude globs.
* `--order <string>`: Rule order; `include,exclude` (default) or `exclude,include`.
* `--root <path>`: Project root for scanning.
* `--dry-run`: Print final file list and exit.
* `--respect-gitignore`: Also exclude files from `.gitignore`.
* `--from <path>`: Read additional paths (one per line) from a file.
* `--ignore-file <paths...>`: Extra ignore files (defaults include `.zipignore`).
* `--no-manifest`: Disable manifest emission.
* `--manifest-path <path>`: Write manifest to an external path.

Alias:

```bash
zipper build [options]
```

---

## 📑 `.zipconfig` format

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

**Fields**

* `include`: glob patterns to include
* `exclude`: glob patterns to ignore
* `presets`: array of preset names
* `out`: output file path
* `respectGitignore`: when true, treat `.gitignore` lines as excludes
* `order`: apply rule precedence (`[include,exclude]` or `[exclude,include]`)

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

---

## 🧩 Presets (reusable rule bundles)

Use presets to avoid repeating include/exclude rules across projects.

Built‑in presets:

* `laravel-basic`
* `laravel-no-vendor`
* `node-module`

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

* When `respectGitignore` is enabled, `.gitignore` rules are applied as **excludes**.

* By default, the order is `[include, exclude]` → excludes win.

* To allow includes to override `.gitignore`, set:

  ```yaml
  order: [exclude, include]
  ```

* This ensures you can re‑include specific files or folders even if ignored by Git.

* If you are **inside** the `stubs/` directory, use `--dir .` when targeting local stubs.

* Built‑in stubs are **always** checked; you can reference them by base name (e.g. `laravel`).

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
