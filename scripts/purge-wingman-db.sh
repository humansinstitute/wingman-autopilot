#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$ROOT/data/wingman.db"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[wingman-db] nothing to purge; $DB_PATH is missing."
  exit 0
fi

BACKUP_PATH="${DB_PATH}.$(date +%Y%m%d%H%M%S).bak"
echo "[wingman-db] backing up current DB to $BACKUP_PATH"
cp "$DB_PATH" "$BACKUP_PATH"

echo "[wingman-db] removing $DB_PATH"
rm "$DB_PATH"

echo "[wingman-db] purge complete. Restart Wingman to let it re-create a fresh database."
