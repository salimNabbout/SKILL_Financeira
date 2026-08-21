#!/bin/bash
set -euo pipefail

DEPLOY_DIR="/opt/financeira/deploy"
DEST="/var/backups/financeira"
LOG="/var/log/financeira-backup.log"
KEEP_DAILY_DAYS=14
KEEP_MONTHLY=12

STAMP="$(date +%F_%H%M)"
TMP_SQL="${DEST}/.tmp-${STAMP}.sql"
OUT="${DEST}/financeira-${STAMP}.sql.gz"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 1048576 ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

cleanup() { rm -f "$TMP_SQL"; }
trap cleanup EXIT

mkdir -p "$DEST/mensais"
chmod 700 "$DEST" "$DEST/mensais"

if ! docker compose -f "${DEPLOY_DIR}/docker-compose.prod.yml" \
      --env-file "${DEPLOY_DIR}/.env.prod" \
      exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
      > "$TMP_SQL" 2>>"$LOG"; then
  log "ERRO: pg_dump falhou. Container db esta de pe?"
  exit 1
fi

if ! grep -q "PostgreSQL database dump complete" "$TMP_SQL"; then
  log "ERRO: dump incompleto. Descartado."
  exit 1
fi

SIZE=$(stat -c%s "$TMP_SQL")
if [ "$SIZE" -lt 1024 ]; then
  log "ERRO: dump com apenas ${SIZE} bytes. Descartado."
  exit 1
fi

gzip -9 -c "$TMP_SQL" > "$OUT"
chmod 600 "$OUT"

if [ "$(date +%d)" = "01" ]; then
  cp -p "$OUT" "${DEST}/mensais/financeira-$(date +%Y-%m).sql.gz"
fi

find "$DEST" -maxdepth 1 -name 'financeira-*.sql.gz' -mtime "+${KEEP_DAILY_DAYS}" -delete
ls -1t "${DEST}/mensais/" 2>/dev/null | tail -n "+$((KEEP_MONTHLY + 1))" | while read -r old; do
  rm -f "${DEST}/mensais/${old}"
done

log "OK: $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"
