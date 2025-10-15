#!/usr/bin/env bash
set -euo pipefail

# ======================== CONFIG (env-overridable) =========================
: "${HOST:?Set HOST (server ip/host) e.g. 209.97.185.174}"
: "${USER:?Set USER (ssh user) e.g. timeax}"
: "${DOMAIN:?Set DOMAIN e.g. tygerbooster.com}"
ZIP_PATH="${ZIP_PATH:-./dist/build.zip}"

# Verbosity (0/1). Adds rsync -v and extra logs.
VERBOSE="${VERBOSE:-0}"

# Health check
#   Option A: HEALTHCHECK_URL="https://example.com/health" (uses curl -f)
#   Option B: HEALTHCHECK_CMD="curl -fsSL https://example.com/health | grep -q ok"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
HEALTHCHECK_CMD="${HEALTHCHECK_CMD:-}"
ROLLBACK_ON_FAIL="${ROLLBACK_ON_FAIL:-1}"      # 1=rollback on healthcheck failure
KEEP_FAILED_DIR="${KEEP_FAILED_DIR:-1}"        # 1=keep failed dir after rollback

# Hooks (newline-separated). Examples:
# PRE_HOOKS_REMOTE_NL=$'php artisan down\nphp artisan cache:clear'
# POST_HOOKS_REMOTE_NL=$'php artisan up'
PRE_HOOKS_LOCAL_NL="${PRE_HOOKS_LOCAL_NL:-}"
POST_HOOKS_LOCAL_NL="${POST_HOOKS_LOCAL_NL:-}"
PRE_HOOKS_REMOTE_NL="${PRE_HOOKS_REMOTE_NL:-}"
POST_HOOKS_REMOTE_NL="${POST_HOOKS_REMOTE_NL:-}"
HOOK_STRICT="${HOOK_STRICT:-1}"                 # 1=abort if any hook fails

# Preserve paths (inside public_html)
# Example: export PRESERVE_NL=$'uploads/\nstorage/\n.well-known/\nrobots.txt'
if [[ -n "${PRESERVE_NL:-}" ]]; then
  mapfile -t PRESERVE_PATHS <<< "$PRESERVE_NL"
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
SSH_PORT="${SSH_PORT:-}"                      # allow empty to defer to ~/.ssh/config
SSH_KEY="${SSH_KEY:-}"                        # allow empty => don't pass -i
SSH_OPTS="${SSH_OPTS:-"-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"}"

SSH_PORT_OPT=""; [[ -n "${SSH_PORT}" ]] && SSH_PORT_OPT="-p ${SSH_PORT}"
SSH_ID_OPT="";   [[ -n "${SSH_KEY}"  ]] && SSH_ID_OPT="-i ${SSH_KEY}"

SSH_DEST="${USER:+${USER}@}${HOST}"
SSH="ssh ${SSH_OPTS} ${SSH_PORT_OPT} ${SSH_ID_OPT} ${SSH_DEST}"
SCP="scp ${SSH_OPTS} ${SSH_PORT_OPT//-p/-P} ${SSH_ID_OPT}"

# Dry-run flag (1 = preview only)
DRY_RUN="${DRY_RUN:-0}"
# ===========================================================================

# ----------------------------- helpers -------------------------------------
say() { printf '%s\n' "$*"; }
note() { printf '• %s\n' "$*"; }
ok()  { printf '✅ %s\n' "$*"; }
warn(){ printf '⚠️  %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

timeit() {
  # usage: timeit "Label" cmd args...
  local label="$1"; shift
  local start end
  start=$(date +%s)
  "$@" || return $?
  end=$(date +%s)
  [[ "$VERBOSE" == "1" ]] && note "$label took $((end-start))s"
}

run_local_hooks() {
  local when="$1" nl="$2"
  [[ -z "$nl" ]] && return 0
  mapfile -t _hooks <<< "$nl"
  for cmd in "${_hooks[@]}"; do
    [[ -z "$cmd" ]] && continue
    note "local ${when}: $cmd"
    if [[ "$DRY_RUN" == "1" ]]; then
      note "DRY RUN: skip local hook"
    else
      bash -lc "$cmd" || { [[ "$HOOK_STRICT" == "1" ]] && die "local ${when} hook failed"; }
    fi
  done
}

run_remote_hooks() {
  local when="$1" nl="$2"
  [[ -z "$nl" ]] && return 0
  mapfile -t _hooks <<< "$nl"
  for cmd in "${_hooks[@]}"; do
    [[ -z "$cmd" ]] && continue
    note "remote ${when}: $cmd"
    if [[ "$DRY_RUN" == "1" ]]; then
      note "DRY RUN: skip remote hook"
    else
      $SSH bash -lc "$cmd" || { [[ "$HOOK_STRICT" == "1" ]] && die "remote ${when} hook failed"; }
    fi
  done
}

show_human_size() {
  local bytes="$1"
  awk -v b="$bytes" 'function human(x){s="B KB MB GB TB PB";for(i=1; x>=1024 && i<6; i++)x/=1024; return sprintf("%.1f %s", x, substr(s, i*3-2, 2))} BEGIN{print human(b)}'
}

healthcheck() {
  # Returns 0 if healthy
  if [[ -n "$HEALTHCHECK_CMD" ]]; then
    [[ "$VERBOSE" == "1" ]] && note "Running HEALTHCHECK_CMD: $HEALTHCHECK_CMD"
    bash -lc "$HEALTHCHECK_CMD"
    return $?
  fi
  if [[ -n "$HEALTHCHECK_URL" ]]; then
    [[ "$VERBOSE" == "1" ]] && note "Probing $HEALTHCHECK_URL"
    curl -fsSL --max-time 15 "$HEALTHCHECK_URL" >/dev/null
    return $?
  fi
  return 0  # no healthcheck configured
}
# ---------------------------------------------------------------------------

[[ -f "$ZIP_PATH" ]] || die "ZIP not found: $ZIP_PATH"

RELEASE_ID="$(date +%Y%m%d-%H%M%S)"
REMOTE_RELEASE_DIR="${REMOTE_TMP}/release-${RELEASE_ID}"
REMOTE_ZIP="${REMOTE_TMP}/deploy-${RELEASE_ID}.zip"
FAILED_DIR="${WEBROOT%/*}/public_html.failed-${RELEASE_ID}"

# ---- PREVIEW --------------------------------------------------------
ZIP_BYTES="$(wc -c < "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH" 2>/dev/null || echo 0)"
ZIP_HUMAN="$(show_human_size "$ZIP_BYTES" 2>/dev/null || echo "${ZIP_BYTES} B")"

say ""
say "====================  DEPLOY PREVIEW  ===================="
say " Target         : ${SSH_DEST}"
say " Webroot        : $WEBROOT"
say " Domain         : $DOMAIN"
say " ZIP            : $ZIP_PATH (${ZIP_HUMAN})"
say " Remote tmp     : $REMOTE_TMP"
say " Backup         : $BACKUP_DIR / ${BACKUP_PREFIX}-<timestamp>.tar.gz"
say " Retention      : keep latest ${BACKUP_RETAIN}"
say " Preserve paths :"
for p in "${PRESERVE_PATHS[@]}"; do say "   • $p"; done
say " Delete mode    : Phase A uses rsync --delete (preserved paths protected)"
say " DRY RUN        : ${DRY_RUN}"
[[ -n "$HEALTHCHECK_URL" ]] && say " Healthcheck    : URL $HEALTHCHECK_URL"
[[ -n "$HEALTHCHECK_CMD" ]] && say " Healthcheck    : CMD $HEALTHCHECK_CMD"
say "========================================================================"
say ""

# Non-interactive guard
if [[ ! -t 0 && -z "${FORCE:-}" && -z "${YES:-}" ]]; then
  die "Refusing to run non-interactively without confirmation. Set YES=1 or FORCE=1."
fi

# Confirm if needed
if [[ -z "${FORCE:-}" && -z "${YES:-}" ]]; then
  read -r -p "Proceed? [y/N] " _ans
  case "${_ans}" in y|Y|yes|YES) ;; *) say "Aborted."; exit 130;; esac
fi
[[ "$DRY_RUN" == "1" ]] && note "(DRY RUN: no changes will be made)" || note "(continuing… actual changes will be made)"
say ""

# ---- REMOTE PRECHECKS ----------------------------------------------
timeit "remote connectivity" $SSH 'echo ok' || die "SSH command failed (SFTP-only?)."
timeit "ensure tmp dir" $SSH "mkdir -p '${REMOTE_TMP}'"
$SSH "test -d '${WEBROOT}'" || die "Webroot does not exist: $WEBROOT"

# Require unzip + rsync on remote
$SSH 'command -v unzip >/dev/null 2>&1' || die "unzip missing on remote (install it)"
$SSH 'command -v rsync >/dev/null 2>&1' || die "rsync missing on remote (install it)"

# ---- PRE-HOOKS (local/remote) --------------------------------------
run_local_hooks  "pre" "$PRE_HOOKS_LOCAL_NL"
run_remote_hooks "pre" "$PRE_HOOKS_REMOTE_NL"

# ---- BACKUP ---------------------------------------------------------
BACKUP_NAME="${BACKUP_PREFIX}-${RELEASE_ID}.tar.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

say "🧰 Preparing backup of ${WEBROOT} -> ${BACKUP_PATH}"
if [[ "$DRY_RUN" == "1" ]]; then
  note "DRY RUN: would create backup and prune older than ${BACKUP_RETAIN} copies."
else
  timeit "backup" \
  $SSH BACKUP_DIR="$BACKUP_DIR" BACKUP_PATH="$BACKUP_PATH" WEBROOT="$WEBROOT" BACKUP_PREFIX="$BACKUP_PREFIX" BACKUP_RETAIN="$BACKUP_RETAIN" bash -s <<'EOF'
set -euo pipefail
have() { command -v "$1" >/dev/null 2>&1; }
mkdir -p "$BACKUP_DIR"
if have pigz; then
  tar -C "${WEBROOT%/*}" -cf - "public_html" | pigz -9 > "$BACKUP_PATH"
else
  tar -C "${WEBROOT%/*}" -czf "$BACKUP_PATH" "public_html"
fi
cnt=0
# shellcheck disable=SC2012
for f in $(ls -1t "$BACKUP_DIR"/"$BACKUP_PREFIX"-*.tar.gz 2>/dev/null); do
  cnt=$((cnt+1))
  if [[ $cnt -gt "$BACKUP_RETAIN" ]]; then rm -f -- "$f"; fi
done
EOF
  ok "Backup created: ${BACKUP_PATH} (kept latest ${BACKUP_RETAIN})"
fi

# ---- UPLOAD & UNPACK -----------------------------------------------
say "⬆️  Uploading zip..."
timeit "upload" $SCP "$ZIP_PATH" "${SSH_DEST}:${REMOTE_ZIP}"

say "📦 Unpacking to ${REMOTE_RELEASE_DIR}..."
timeit "unpack" $SSH "mkdir -p '${REMOTE_RELEASE_DIR}' && unzip -q '${REMOTE_ZIP}' -d '${REMOTE_RELEASE_DIR}'"

# ---- FILTER A: protect + exclude preserved + skip dotfiles ---------
FILTER_LOCAL="/tmp/.local-filterA-${RELEASE_ID}"
FILTER_REMOTE="/tmp/.deploy-filterA-${RELEASE_ID}.rsync"
{
  for p in "${PRESERVE_PATHS[@]}"; do
    [[ "$p" == /* ]] || p="/$p"
    echo "P $p"
    echo "- $p"
  done
  echo "- .*"   # exclude dotfiles (order matters!)
  echo "+ */"   # allow directory traversal
  echo "+ *"    # include everything else
} > "$FILTER_LOCAL"

timeit "upload filter" $SCP "$FILTER_LOCAL" "${SSH_DEST}:${FILTER_REMOTE}"
rm -f "$FILTER_LOCAL"

# ---- Phase A: sync all EXCEPT preserved (with deletes) -------------
RSYNC_A_BASE="-a --delete --delete-delay --force --itemize-changes --human-readable --stats"
[[ "$VERBOSE" == "1" ]] && RSYNC_A_BASE="${RSYNC_A_BASE} -v"
[[ "$DRY_RUN" == "1" ]] && RSYNC_A_BASE="--dry-run ${RSYNC_A_BASE}"

say "🔁 Phase A: site sync (excluding preserved, with delete)..."
timeit "phase A rsync" \
$SSH "mkdir -p '${WEBROOT}' && rsync ${RSYNC_A_BASE} --filter='. ${FILTER_REMOTE}' '${REMOTE_RELEASE_DIR}/' '${WEBROOT}/'"

# ---- Phase B: merge into preserved (no overwrite, no delete) -------
say "➕ Phase B: merge new files INTO preserved paths (no overwrite)..."
for p in "${PRESERVE_PATHS[@]}"; do
  rel="${p#/}"  # strip leading slash if any
  if [[ "$rel" == */ ]]; then
    # directory case
    src="${REMOTE_RELEASE_DIR%/}/${rel%/}/"
    dst="${WEBROOT%/}/${rel%/}/"
    if ! $SSH "test -d '${src%/}'"; then
      note "skip '${rel}' (dir) not in release"; continue
    fi
    $SSH "mkdir -p '${dst}'"
    RSYNC_B="-a --ignore-existing --itemize-changes --human-readable --stats"
    [[ "$VERBOSE" == "1" ]] && RSYNC_B="${RSYNC_B} -v"
    [[ "$DRY_RUN" == "1" ]] && RSYNC_B="--dry-run ${RSYNC_B}"
    note "merge '${rel}'"
    timeit "phase B rsync ${rel}" \
    $SSH "rsync ${RSYNC_B} '${src}' '${dst}'"
  else
    # file case
    src="${REMOTE_RELEASE_DIR%/}/${rel}"
    dst="${WEBROOT%/}/${rel}"
    if ! $SSH "test -f '${src}'"; then
      note "skip '${rel}' (file) not in release"; continue
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      note "would copy file '${rel}' if missing"
    else
      timeit "phase B copy ${rel}" \
      $SSH "mkdir -p '$(dirname "$dst")' && cp -n '${src}' '${dst}' 2>/dev/null || true"
    fi
  fi
done

# ---- ownership (best-effort) ---------------------------------------
if [[ "$DRY_RUN" != "1" ]]; then
  note "ensure ownership (best-effort)…"
  $SSH "chown -R ${USER}:${USER} '${WEBROOT}'" || warn "chown skipped (needs sudo or already owned)."
fi

# ---- HEALTHCHECK + optional rollback --------------------------------
rollback() {
  warn "healthcheck FAILED — starting rollback"
  # Move current to failed dir, then restore backup tarball
  $SSH "mv '${WEBROOT}' '${FAILED_DIR}' && mkdir -p '${WEBROOT%/*}' && tar -C '${WEBROOT%/*}' -xzf '${BACKUP_PATH}'" || {
    die "rollback failed. Manual intervention required."
  }
  ok "Rollback restored backup to ${WEBROOT}"
  if [[ "$KEEP_FAILED_DIR" != "1" ]]; then
    $SSH "rm -rf '${FAILED_DIR}'" || true
  else
    note "Kept failed dir at ${FAILED_DIR}"
  fi
}

if [[ "$DRY_RUN" != "1" ]]; then
  if healthcheck; then
    ok "Healthcheck passed"
    # cleanup tmp after success
    note "cleanup tmp..."
    $SSH "rm -f '${REMOTE_ZIP}' '${FILTER_REMOTE}' && rm -rf '${REMOTE_RELEASE_DIR}'" || true
  else
    if [[ "$ROLLBACK_ON_FAIL" == "1" ]]; then
      rollback
    else
      warn "Healthcheck failed; rollback disabled. Leaving release + tmp for inspection."
    fi
  fi
else
  note "DRY RUN: kept ZIP, filter, and release dir for inspection."
fi

# ---- POST-HOOKS (remote/local) -------------------------------------
run_remote_hooks "post" "$POST_HOOKS_REMOTE_NL"
run_local_hooks  "post" "$POST_HOOKS_LOCAL_NL"

ok "Done."