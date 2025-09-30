#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG (all are overridable via env) =========================
HOST="${HOST}"
USER="${USER}"
DOMAIN="${DOMAIN}"

# Where deploy saves backups (same prefix as upload.sh)
BACKUP_DIR="${BACKUP_DIR:-/home/${USER}/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-${DOMAIN}-public_html}"

# Exact filename to restore (inside BACKUP_DIR). If empty => pick latest.
BACKUP_NAME="${BACKUP_NAME:-}"

# Safety + preview
DRY_RUN="${DRY_RUN:-0}"       # 1 = preview only
FORCE="${FORCE:-0}"           # 1 = skip interactive "YES" prompt

# SSH controls (optional)
SSH_PORT="${SSH_PORT:-}"      # e.g. 22
SSH_KEY="${SSH_KEY:-}"        # e.g. ~/.ssh/id_ed25519
SSH_OPTS_DEFAULT="-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
SSH_OPTS="${SSH_OPTS:-$SSH_OPTS_DEFAULT}"
[[ -n "$SSH_PORT" ]] && SSH_OPTS="$SSH_OPTS -p $SSH_PORT"
[[ -n "$SSH_KEY"  ]] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

WEBROOT="${WEBROOT:-/home/${USER}/web/${DOMAIN}/public_html}"
SSH="ssh $SSH_OPTS ${USER}@${HOST}"
SCP="scp $SSH_OPTS"
# ====================================================================

# --- preflight -------------------------------------------------------
if ! $SSH 'echo ok' >/dev/null 2>&1; then
  echo "❌ SSH key auth or shell access failed for ${USER}@${HOST}."
  echo "   Hint: ensure your key is loaded (ssh-add) and user has a shell."
  exit 1
fi

$SSH "test -d '$WEBROOT'" || { echo "❌ Missing webroot: $WEBROOT"; exit 1; }
$SSH "test -d '$BACKUP_DIR'" || { echo "❌ Missing backup dir: $BACKUP_DIR"; exit 1; }

# Pick backup (latest if not specified)
if [[ -z "$BACKUP_NAME" ]]; then
  BACKUP_NAME="$($SSH "ls -1t $BACKUP_DIR/${BACKUP_PREFIX}-*.tar.gz 2>/dev/null | head -n1 | xargs -n1 basename" || true)"
fi
[[ -n "$BACKUP_NAME" ]] || { echo "❌ No backups found in $BACKUP_DIR with prefix ${BACKUP_PREFIX}-*.tar.gz"; exit 1; }

BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
echo "📦 Selected backup: $BACKUP_PATH"

# Confirm
if [[ "$FORCE" != "1" ]]; then
  echo "⚠️  This will RESTORE $WEBROOT from '$BACKUP_NAME' (deletes/overwrites files)."
  read -r -p "Type YES to proceed (or anything else to abort): " ANSWER
  [[ "$ANSWER" == "YES" ]] || { echo "Aborted."; exit 1; }
fi

RESTORE_ID="$(date +%Y%m%d-%H%M%S)"
REMOTE_TMP="/home/${USER}/tmp/restore-${RESTORE_ID}"

[[ "$DRY_RUN" == "1" ]] && echo "🧪 DRY RUN: will simulate extraction + rsync to $WEBROOT"

# --- restore flow (server-side) -------------------------------------
# NOTE: we use an unquoted here-doc and inject *literal* values safely in single quotes.
$SSH bash -s <<EOF
set -euo pipefail

BACKUP_DIR='$BACKUP_DIR'
BACKUP_PATH='$BACKUP_PATH'
WEBROOT='$WEBROOT'
REMOTE_TMP='$REMOTE_TMP'
DRY_RUN='$DRY_RUN'
USERN='$USER'

have(){ command -v "\$1" >/dev/null 2>&1; }

# Tool checks
if ! have rsync; then
  echo "❌ 'rsync' is required on the server for restore."; exit 1
fi
if ! have tar; then
  echo "❌ 'tar' is required on the server for restore."; exit 1
fi

# 1) Prepare temp dir
mkdir -p "\$REMOTE_TMP"

# 2) Extract backup into temp dir
echo "📤 Extracting backup into \$REMOTE_TMP ..."
if [[ "\$DRY_RUN" == "1" ]]; then
  echo "🧪 DRY RUN: (tar -xzf \"\$BACKUP_PATH\" -C \"\$REMOTE_TMP\")"
else
  tar -C "\$REMOTE_TMP" -xzf "\$BACKUP_PATH"
fi

EXTRACTED="\$REMOTE_TMP/public_html"
if [[ "\$DRY_RUN" != "1" ]]; then
  test -d "\$EXTRACTED" || { echo "❌ Extracted path missing: \$EXTRACTED"; exit 1; }
fi

# 3) Rsync extracted tree back to webroot (authoritative restore)
RS_FLAGS="-a --delete --delete-delay --force --itemize-changes --human-readable --stats"
[[ "\$DRY_RUN" == "1" ]] && RS_FLAGS="--dry-run \$RS_FLAGS"

echo "🔁 Restoring files to \$WEBROOT ..."
rsync \$RS_FLAGS "\$EXTRACTED/" "\$WEBROOT/"

# 4) Fix ownership
if [[ "\$DRY_RUN" != "1" ]]; then
  echo "🧾 chown \$USERN:\$USERN ..."
  chown -R "\$USERN:\$USERN" "\$WEBROOT" || true
fi

# 5) Cleanup temp
if [[ "\$DRY_RUN" != "1" ]]; then
  echo "🧹 Cleaning up \$REMOTE_TMP ..."
  rm -rf "\$REMOTE_TMP"
else
  echo "ℹ️  DRY RUN: kept \$REMOTE_TMP for inspection."
fi

echo "✅ Restore complete."
EOF