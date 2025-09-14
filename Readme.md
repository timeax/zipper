# Zipper

A flexible project archiver and configuration-based zipping tool. Zipper lets you define which files to include/exclude in your project archives using a simple `.zipconfig` file or presets. It works great for Laravel, Node.js, Inertia apps, or any custom setup.

---

## ✨ Features

* **Config-driven**: Use a `.zipconfig` file to declare includes, excludes, presets.
* **Stubs**: Predefined config templates (`.stub` files) for Laravel, Node, Inertia, etc.
* **Presets**: Built-in and user-defined presets for reusable include/exclude patterns.
* **Global stubs/presets**: Store your own defaults under `~/.config/zipper/` for reuse.
* **CLI commands**: Easy to init, build, list, export, import, and migrate presets.
* **Cross-platform**: Works on Linux, macOS, and Windows.

---

## 📦 Installation

```bash
npm install -g @timeax/zipper
```

You can also install locally in a project:

```bash
npm install --save-dev @timeax/zipper
```

---

## 🛠 Usage

### 1. Initialize config

```bash
zipper init laravel
```

This creates a `.zipconfig` file in your project root using the `laravel.stub` template.

* If you omit the extension, `.stub` is assumed.
* Stubs are searched locally (`./stubs/`) and globally (`~/.config/zipper/stubs`).

### 2. Build an archive

```bash
zipper build
```

By default, this reads `.zipconfig`, includes/excludes files, and produces `project.zip`.

Options:

```bash
zipper build --out ./dist/my-app.zip
zipper build --config ./custom-config.yml
```

### 3. Presets

Use presets to avoid repeating config across multiple projects.

```yaml
# .zipconfig
global: true
include:
  - app/**
exclude:
  - vendor/**
presets:
  - laravel-basic
  - my-company.inertia
```

Built-in presets:

* `laravel-basic`
* `laravel-no-vendor`
* `node-module`

#### Listing & showing

```bash
zipper preset ls
zipper preset show laravel-basic --format yaml
```

#### Adding & removing

```bash
# Create from existing .zipconfig
zipper preset add my-company.laravel --from .zipconfig

# Add quickly via CLI
zipper preset add node-ci --include dist/** --exclude node_modules/**

# Remove a user preset
zipper preset rm my-company.laravel
```

#### Exporting & importing

```bash
# Export a preset to a YAML file
zipper preset export laravel-basic --to laravel-basic.yml

# Import a preset from a stub/config file
zipper preset import inertia-prod --from stubs/inertia-prod.stub
```

#### Renaming

```bash
zipper preset rename old-name new-name
```

#### Migrating in bulk

```bash
# Interactive multi-select
zipper preset migrate --include-globals

# Non-interactive: migrate everything
zipper preset migrate --all

# Dry run
zipper preset migrate --all --dry-run
```

---

## 📑 `.zipconfig` Format

YAML or JSON supported. Example:

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
```

Fields:

* `include`: glob patterns to include
* `exclude`: glob patterns to ignore
* `presets`: array of preset names
* `out`: output file path

---

## 📂 Stubs

Zipper ships with stubs under `stubs/`:

* `node.stub`
* `laravel.stub`
* `inertia.stub`

Users can also:

* Place custom stubs in `./stubs/`
* Place global stubs in `~/.config/zipper/stubs/`

Commands:

```bash
zipper stub ls
zipper stub add stubs/custom.stub
```

---

## 🌍 Global Presets & Stubs

User presets and stubs are stored under:

* `~/.config/zipper/presets`
* `~/.config/zipper/stubs`

You can override the location with environment variables:

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

## 🔌 Example Workflows

### Laravel app

```bash
cd laravel-app
zipper init laravel
zipper build --out build/laravel-app.zip
```

### Node package

```bash
cd node-lib
zipper init node
zipper preset add node-publish --include dist/** --exclude tests/**
zipper build --config .zipconfig --out dist/lib.zip
```

### Inertia.js project

```bash
cd inertia-site
zipper init inertia
zipper build --out dist/site.zip
```

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
