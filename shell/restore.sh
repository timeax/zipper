#!/usr/bin/env bash
set -euo pipefail

# ======================== CONFIG (env-overridable) =========================
: "${HOST:?Set HOST (server ip/host)}"
: "${USER:?Set USER (ssh user)}"
: "${DOMAIN:?Set DOMAIN (e.g. tygerbooster.com)}"

BACKUP_DIR="${BACKUP_DIR:-/home/${USER}/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-${DOMAIN}-public_html}"
BACKUP_NAME="${BACKUP_NAME:-}"        # If empty, pick latest remotely

WEBROOT="${WEBROOT:-/home/${USER}/web/${DOMAIN}/public_html}"

# Safety / UX
DRY_RUN="${DRY_RUN:-0}"               # 1 = simulate
FORCE="${FORCE:-0}"                   # 1 = skip YES prompt
VERBOSE="${VERBOSE:-0}"               # 1 = extra logs

# Healthcheck + rollback
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"      # e.g. https://tygerbooster.com/health
HEALTHCHECK_CMD="${HEALTHCHECK_CMD:-}"      # e.g. "curl -fsSL ... | grep -q ok"
ROLLBACK_ON_FAIL="${ROLLBACK_ON_FAIL:-1}"   # 1 = rollback if healthcheck fails
KEEP_PRE_DIR="${KEEP_PRE_DIR:-1}"           # 1 = keep pre-snapshot after success
KEEP_FAILED_DIR="${KEEP_FAILED_DIR:-1}"     # 1 = keep failed dir after rollback

# SSH controls
SSH_PORT="${SSH_PORT:-}"
SSH_KEY="${SSH_KEY:-}"
SSH_OPTS_DEFAULT="-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
SSH_OPTS="${SSH_OPTS:-$SSH_OPTS_DEFAULT}"
[[ -n "$SSH_PORT" ]] && SSH_OPTS="$SSH_OPTS -p $SSH_PORT"
[[ -n "$SSH_KEY"  ]] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

SSH_DEST="${USER:+${USER}@}${HOST}"
SSH="ssh $SSH_OPTS ${SSH_DEST}"
SCP="scp $SSH_OPTS"
# ===========================================================================

say()  { printf '%s\n' "$*"; }
note() { printf '• %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

healthcheck() {
  if [[ -n "$HEALTHCHECK_CMD" ]]; then
    [[ "$VERBOSE" == "1" ]] && note "HEALTHCHECK_CMD: $HEALTHCHECK_CMD"
    bash -lc "$HEALTHCHECK_CMD"
    return $?
  fi
  if [[ -n "$HEALTHCHECK_URL" ]]; then
    [[ "$VERBOSE" == "1" ]] && note "HEALTHCHECK_URL: $HEALTHCHECK_URL"
    curl -fsSL --max-time 15 "$HEALTHCHECK_URL" >/dev/null
    return $?
  fi
  return 0  # no healthcheck configured
}

# --- preflight -------------------------------------------------------
$SSH 'echo ok' >/dev/null 2>&1 || die "SSH auth or shell access failed for ${SSH_DEST}"
$SSH "test -d '$WEBROOT'"      || die "Missing webroot: $WEBROOT"
$SSH "test -d '$BACKUP_DIR'"   || die "Missing backup dir: $BACKUP_DIR"

# Choose backup if not provided (remote, safe)
if [[ -z "$BACKUP_NAME" ]]; then
  BACKUP_NAME="$(
    $SSH BACKUP_DIR="$BACKUP_DIR" BACKUP_PREFIX="$BACKUP_PREFIX" bash -lc '
      set -euo pipefail
      shopt -s nullglob
      mapfile -t arr < <(ls -1t -- "$BACKUP_DIR"/"$BACKUP_PREFIX"-*.tar.gz 2>/dev/null || true)
      if (( ${#arr[@]} == 0 )); then
        echo ""
      else
        basename -- "${arr[0]}"
      fi
    '
  )"
fi
[[ -n "$BACKUP_NAME" ]] || die "No backups found in $BACKUP_DIR with prefix ${BACKUP_PREFIX}-*.tar.gz"

BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
$SSH "test -f '$BACKUP_PATH'" || die "Backup file not found: $BACKUP_PATH"

SITE_ROOT="${WEBROOT%/*}"  # parent of public_html
RESTORE_ID="$(date +%Y%m%d-%H%M%S)"
REMOTE_TMP="/home/${USER}/tmp/restore-${RESTORE_ID}"
PRE_DIR="${SITE_ROOT}/public_html.pre-${RESTORE_ID}"
FAILED_DIR="${SITE_ROOT}/public_html.failed-restore-${RESTORE_ID}"

# Preview
say ""
say "====================  RESTORE PREVIEW  ===================="
say " Target        : ${SSH_DEST}"
say " Webroot       : $WEBROOT"
say " Backup        : $BACKUP_PATH"
say " Pre-snapshot  : $PRE_DIR"
say " Healthcheck   : ${HEALTHCHECK_URL:+URL} ${HEALTHCHECK_CMD:+CMD}"
say " Rollback      : ${ROLLBACK_ON_FAIL}"
say " DRY RUN       : $DRY_RUN"
say "==========================================================="
say ""

# Confirm
if [[ "$FORCE" != "1" ]]; then
  printf "⚠️  This will RESTORE %s from '%s' (overwrites files).\n" "$WEBROOT" "$BACKUP_NAME"
  read -r -p "Type YES to proceed (or anything else to abort): " ANSWER
  [[ "$ANSWER" == "YES" ]] || { echo "Aborted."; exit 1; }
fi

[[ "$DRY_RUN" == "1" ]] && note "DRY RUN: simulating extraction + swap + rsync + healthcheck"

# --- remote restore flow --------------------------------------------
# We keep the heavy lifting server-side and pass the essential vars.
$SSH VERBOSE="$VERBOSE" DRY_RUN="$DRY_RUN" BACKUP_PATH="$BACKUP_PATH" \
    WEBROOT="$WEBROOT" SITE_ROOT="$SITE_ROOT" REMOTE_TMP="$REMOTE_TMP" \
    PRE_DIR="$PRE_DIR" FAILED_DIR="$FAILED_DIR" bash -s <<'EOF'
set -euo pipefail
vnote(){ [[ "${VERBOSE:-0}" == "1" ]] && printf '• %s\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

have rsync || { echo "❌ 'rsync' is required on the server."; exit 1; }
have tar   || { echo "❌ 'tar' is required on the server."; exit 1; }

# 1) Extract backup into temp dir (expects 'public_html/' at top level)
mkdir -p "$REMOTE_TMP"
echo "📤 Extracting backup into $REMOTE_TMP ..."
if [[ "$DRY_RUN" == "1" ]]; then
  echo "🧪 DRY RUN: (tar -xzf \"$BACKUP_PATH\" -C \"$REMOTE_TMP\")"
else
  tar -C "$REMOTE_TMP" -xzf "$BACKUP_PATH"
fi

EXTRACTED="$REMOTE_TMP/public_html"
if [[ "$DRY_RUN" != "1" ]]; then
  test -d "$EXTRACTED" || { echo "❌ Extracted path missing: $EXTRACTED"; exit 1; }
fi

# 2) Snapshot current site by renaming public_html -> public_html.pre-TS
echo "🪪 Snapshot current site -> $PRE_DIR"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "🧪 DRY RUN: (mv \"$WEBROOT\" \"$PRE_DIR\" && mkdir -p \"$WEBROOT\")"
else
  mv "$WEBROOT" "$PRE_DIR"
  mkdir -p "$WEBROOT"
fi

# 3) Restore into a fresh $WEBROOT via rsync (authoritative)
RS_FLAGS="-a --delete --delete-delay --force --itemize-changes --human-readable --stats"
[[ "${VERBOSE:-0}" == "1" ]] && RS_FLAGS="$RS_FLAGS -v"
[[ "$DRY_RUN" == "1" ]] && RS_FLAGS="--dry-run $RS_FLAGS"

echo "🔁 Restoring files to $WEBROOT ..."
rsync $RS_FLAGS "$EXTRACTED/" "$WEBROOT/"

# 4) Fix ownership (best-effort)
if [[ "$DRY_RUN" != "1" ]]; then
  # NB: we cannot know the username here cleanly; chown at the caller after healthcheck.
  vnote "Ownership will be adjusted by caller."
fi

# 5) Leave tmp for caller (healthcheck/cleanup/rollback done outside)
echo "✅ Restore payload staged in $WEBROOT (pre-snapshot at $PRE_DIR)"
EOF

# 6) Healthcheck + rollback (local side)
if [[ "$DRY_RUN" != "1" ]]; then
  if healthcheck; then
    note "Healthcheck passed"
    # Ownership (best-effort) and cleanup
    $SSH "chown -R ${USER}:${USER} '${WEBROOT}'" || warn "chown skipped (needs sudo or already owned)."
    # Cleanup temp
    $SSH "rm -rf '${REMOTE_TMP}'" || true
    # Keep or remove pre-snapshot
    if [[ "$KEEP_PRE_DIR" == "1" ]]; then
      note "Kept pre-snapshot at ${PRE_DIR}"
    else
      note "Removing pre-snapshot ${PRE_DIR}"
      $SSH "rm -rf '${PRE_DIR}'" || true
    fi
    say "✅ Restore complete."
  else
    warn "Healthcheck failed."
    if [[ "$ROLLBACK_ON_FAIL" == "1" ]]; then
      warn "Starting rollback…"
      # Move broken site aside and put the pre-snapshot back
      $SSH WEBROOT="$WEBROOT" PRE_DIR="$PRE_DIR" FAILED_DIR="$FAILED_DIR" bash -s <<'EOF'
set -euo pipefail
# Move current webroot aside, restore pre-snapshot
mv "$WEBROOT" "$FAILED_DIR"
mv "$PRE_DIR" "$WEBROOT"
EOF
      # Cleanup temp
      $SSH "rm -rf '${REMOTE_TMP}'" || true
      [[ "$KEEP_FAILED_DIR" == "1" ]] || $SSH "rm -rf '${FAILED_DIR}'" || true
      say "↩️  Rolled back to pre-snapshot. (Failed tree saved at ${FAILED_DIR})"
    else
      warn "Rollback disabled. Pre-snapshot left at ${PRE_DIR}. Inspect and resolve manually."
    fi
  fi
else
  note "DRY RUN: no changes made; leaving $REMOTE_TMP and $WEBROOT unchanged."
fi