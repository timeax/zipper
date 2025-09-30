#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG (env-overridable) ====================================
HOST="${HOST}"
USER="${USER}"
DOMAIN="${DOMAIN}"
ZIP_PATH="${ZIP_PATH:-./dist/build.zip}"

# Preserve paths (inside public_html). Prefer PRESERVE_NL if provided.
# Example: export PRESERVE_NL=$'uploads/\nstorage/\n.well-known/\nrobots.txt'
if [[ -n "${PRESERVE_NL:-}" ]]; then
  # newline-separated → array
  IFS=$'\n' read -r -d '' -a PRESERVE_PATHS < <(printf '%s\0' "${PRESERVE_NL}")
else
  PRESERVE_PATHS=(
    "uploads/"
    "storage/"
    ".well-known/"
    "robots.txt"
  )
fi

# Backup settings
BACKUP_DIR="${BACKUP_DIR:-/home/${USER}/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-${DOMAIN}-public_html}"
BACKUP_RETAIN="${BACKUP_RETAIN:-7}"

# Layout
WEBROOT="${WEBROOT:-/home/${USER}/web/${DOMAIN}/public_html}"
REMOTE_TMP="${REMOTE_TMP:-/home/${USER}/tmp}"

# SSH wiring (key, port, and base opts)
# --- defaults ---
SSH_PORT="${SSH_PORT:-}"                      # allow empty to defer to ~/.ssh/config
SSH_KEY="${SSH_KEY:-}"                        # allow empty => don't pass -i
SSH_OPTS="${SSH_OPTS:-"-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"}"

# Build optional flags only if set
SSH_PORT_OPT=""
[[ -n "${SSH_PORT}" ]] && SSH_PORT_OPT="-p ${SSH_PORT}"

SSH_ID_OPT=""
[[ -n "${SSH_KEY}" ]] && SSH_ID_OPT="-i ${SSH_KEY}"

# If USER is empty, let ~/.ssh/config provide User
SSH_DEST="${USER:+${USER}@}${HOST}"

SSH="ssh ${SSH_OPTS} ${SSH_PORT_OPT} ${SSH_ID_OPT} ${SSH_DEST}"
SCP="scp ${SSH_OPTS} ${SSH_PORT_OPT//-p/-P} ${SSH_ID_OPT}"

# Dry-run flag (1 = preview only)
DRY_RUN="${DRY_RUN:-0}"
# ====================================================================

[[ -f "$ZIP_PATH" ]] || { echo "❌ ZIP not found: $ZIP_PATH" >&2; exit 1; }

RELEASE_ID="$(date +%Y%m%d-%H%M%S)"
REMOTE_RELEASE_DIR="${REMOTE_TMP}/release-${RELEASE_ID}"
REMOTE_ZIP="${REMOTE_TMP}/deploy-${RELEASE_ID}.zip"

# ---- SAFETY CONFIRMATION ----------------------------------------------------
show_human_size() {
  local bytes="$1"
  awk -v b="$bytes" 'function human(x){s="B KB MB GB TB PB";for(i=1; x>=1024 && i<6; i++)x/=1024; return sprintf("%.1f %s", x, substr(s, i*3-2, 2))} BEGIN{print human(b)}'
}
ZIP_BYTES="$(wc -c < "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH" 2>/dev/null || echo 0)"
ZIP_HUMAN="$(show_human_size "$ZIP_BYTES" 2>/dev/null || echo "${ZIP_BYTES} B")"

echo
echo "====================  DEPLOY PREVIEW  ===================="
echo " Target         : ${USER:+$USER@}$HOST"
echo " Webroot        : $WEBROOT"
echo " Domain        : $DOMAIN"
echo " ZIP            : $ZIP_PATH (${ZIP_HUMAN})"
echo " Remote tmp     : $REMOTE_TMP"
echo " Backup         : $BACKUP_DIR / ${BACKUP_PREFIX}-<timestamp>.tar.gz"
echo " Retention      : keep latest ${BACKUP_RETAIN}"
echo " Preserve paths :"
for p in "${PRESERVE_PATHS[@]}"; do
  echo "   • $p"
done
echo " Delete mode    : Phase A uses rsync --delete (preserved paths protected)"
echo " DRY RUN        : ${DRY_RUN}"
echo "=========================================================="
echo

# If non-interactive (no TTY) and not forced, abort with hint
if [[ ! -t 0 && -z "${FORCE:-}" && -z "${YES:-}" ]]; then
  echo "Refusing to run non-interactively without confirmation."
  echo "Set YES=1 or FORCE=1 to proceed in CI."
  exit 64
fi

# If neither YES nor FORCE is set, ask for confirmation
if [[ -z "${FORCE:-}" && -z "${YES:-}" ]]; then
  read -r -p "Proceed? [y/N] " _ans
  case "${_ans}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 130 ;;
  esac
fi

# Optional: extra warning when not a dry run
if [[ "$DRY_RUN" != "1" ]]; then
  echo "(continuing… actual changes will be made)"
else
  echo "(DRY RUN: no changes will be made)"
fi
echo
# ---------------------------------------------------------------------------

# Prove we can run remote commands (not SFTP-only)
if ! $SSH 'echo ok' >/dev/null 2>&1; then
  echo "❌ SSH key auth not available or user cannot execute commands (SFTP-only?)."
  echo "   Ensure ${USER} has a shell in host or run via root + sudo -u ${USER}."
  exit 1
fi

# Ensure dirs exist
$SSH "mkdir -p '${REMOTE_TMP}'"
$SSH "test -d '${WEBROOT}'"

# --- BACKUP (always before changing anything) -----------------------
BACKUP_NAME="${BACKUP_PREFIX}-${RELEASE_ID}.tar.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

echo "🧰 Preparing backup of ${WEBROOT} -> ${BACKUP_PATH}"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "🧪 DRY RUN: would create backup and prune older than ${BACKUP_RETAIN} copies."
else
  # Pass variables via environment; keep heredoc literal for safety
  $SSH BACKUP_DIR="$BACKUP_DIR" BACKUP_PATH="$BACKUP_PATH" WEBROOT="$WEBROOT" BACKUP_PREFIX="$BACKUP_PREFIX" BACKUP_RETAIN="$BACKUP_RETAIN" bash -s <<'EOF'
set -euo pipefail
have() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$BACKUP_DIR"

# Fast path: pigz if available (parallel gzip), else gzip
if have pigz; then
  tar -C "${WEBROOT%/*}" -cf - "public_html" | pigz -9 > "$BACKUP_PATH"
else
  tar -C "${WEBROOT%/*}" -czf "$BACKUP_PATH" "public_html"
fi

# Retention: keep newest N backups
cnt=0
# shellcheck disable=SC2012
for f in $(ls -1t "$BACKUP_DIR"/"$BACKUP_PREFIX"-*.tar.gz 2>/dev/null); do
  cnt=$((cnt+1))
  if [[ $cnt -gt ${BACKUP_RETAIN} ]]; then
    rm -f -- "$f"
  fi
done
EOF
  echo "✅ Backup created: ${BACKUP_PATH} (kept latest ${BACKUP_RETAIN})"
fi

# --- upload & unpack -------------------------------------------------
echo "⬆️  Uploading zip..."
$SCP "$ZIP_PATH" "${USER}@${HOST}:${REMOTE_ZIP}"

echo "📦 Unpacking to ${REMOTE_RELEASE_DIR}..."
$SSH ZIP="$REMOTE_ZIP" RELEASE_DIR="$REMOTE_RELEASE_DIR" bash -s <<'EOF'
set -euo pipefail
mkdir -p "$RELEASE_DIR"
if ! command -v unzip >/dev/null 2>&1; then
  sudo apt-get update -y && sudo apt-get install -y unzip
fi
unzip -q "$ZIP" -d "$RELEASE_DIR"
EOF

# --- Build FILTER A: protect + exclude preserved --------------------
FILTER_LOCAL="/tmp/.local-filterA-${RELEASE_ID}"
FILTER_REMOTE="/tmp/.deploy-filterA-${RELEASE_ID}.rsync"

{
  for p in "${PRESERVE_PATHS[@]}"; do
    [[ "$p" == /* ]] || p="/$p"
    echo "P $p"     # protect from deletion
    echo "- $p"     # exclude from transfer in Phase A
  done
  echo "+ */"
  echo "+ *"
  echo "- .*"
} > "$FILTER_LOCAL"

$SCP "$FILTER_LOCAL" "${USER}@${HOST}:${FILTER_REMOTE}"
rm -f "$FILTER_LOCAL"

# --- Phase A: sync all EXCEPT preserved (with deletes) --------------
RSYNC_FLAGS_A="-a --delete --delete-delay --force --itemize-changes --human-readable --stats --filter=. ${FILTER_REMOTE}"
[[ "$DRY_RUN" == "1" ]] && RSYNC_FLAGS_A="--dry-run ${RSYNC_FLAGS_A}"

echo "🔁 Phase A: site sync (excluding preserved, with delete)..."
$SSH "mkdir -p '${WEBROOT}'"
$SSH "rsync ${RSYNC_FLAGS_A} '${REMOTE_RELEASE_DIR}/' '${WEBROOT}/'"

# --- Phase B: merge (no overwrite, no delete) into preserved paths --
echo "➕ Phase B: merge new files INTO preserved paths (no overwrite)..."
for p in "${PRESERVE_PATHS[@]}"; do
  rel="${p#/}"                           # strip leading slash if any
  src="${REMOTE_RELEASE_DIR%/}/${rel%/}/"
  dst="${WEBROOT%/}/${rel%/}/"

  # Skip if release doesn’t have this path
  if ! $SSH "test -e '${src%/}'"; then
    echo "   - (skip) '${rel}' not in release"
    continue
  fi

  # Ensure target exists
  $SSH "mkdir -p '${dst}'"

  RSYNC_FLAGS_B="-a --ignore-existing --itemize-changes --human-readable --stats"
  [[ "$DRY_RUN" == "1" ]] && RSYNC_FLAGS_B="--dry-run ${RSYNC_FLAGS_B}"

  echo "   - merging into '${rel}'"
  $SSH "rsync ${RSYNC_FLAGS_B} '${src}' '${dst}'"
done

# --- ownership & cleanup --------------------------------------------
if [[ "$DRY_RUN" != "1" ]]; then
  echo "🧾 chown ${USER}:${USER} ..."
  $SSH "chown -R ${USER}:${USER} '${WEBROOT}'"

  echo "🧹 cleanup tmp..."
  $SSH "rm -f '${REMOTE_ZIP}' '${FILTER_REMOTE}' && rm -rf '${REMOTE_RELEASE_DIR}'"
else
  echo "ℹ️  DRY RUN: kept ZIP, filter, and release dir for inspection."
fi

echo "✅ Done."