#!/bin/bash
#
# Copia off-site dos backups do Financeira PME — modelo PULL.
#
# Roda na VPS de DESTINO (a maquina secundaria), nao na de producao: assim a
# chave privada vive fora do servidor exposto, e quem comprometer a producao
# nao alcanca os backups para apaga-los. Na producao, a chave publica esta
# autorizada com command="/root/.ssh/rsync-only.sh", que permite apenas LER
# /var/backups/financeira.
#
# Instalar no destino:
#   curl -fsSL <raw do repo>/deploy/pull-offsite.sh -o /root/pull-backup-financeira.sh
#   chmod 700 /root/pull-backup-financeira.sh
#   printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n15 3 * * * root /root/pull-backup-financeira.sh\n' > /etc/cron.d/financeira-offsite
#
set -uo pipefail

ORIGEM="root@2.25.132.128:/var/backups/financeira/"
KEY="/root/.ssh/financeira_pull"
DEST="/var/backups/financeira-offsite"
LOG="/var/log/financeira-offsite.log"
MANTER=60          # dias mantidos aqui (a producao mantem 14)
ALERTA_DIAS=2      # avisa se o backup mais recente ficar mais velho que isso

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 1048576 ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

mkdir -p "$DEST"
chmod 700 "$DEST"

if [ ! -f "$KEY" ]; then
  log "ERRO: chave $KEY nao encontrada."
  exit 1
fi

if ! rsync -az --timeout=180 \
     -e "ssh -i $KEY -o StrictHostKeyChecking=no -o ConnectTimeout=25 -o BatchMode=yes" \
     "$ORIGEM" "$DEST/" >>"$LOG" 2>&1; then
  log "ERRO: rsync falhou (producao fora do ar, rede ou chave revogada?)."
  exit 1
fi

find "$DEST" -maxdepth 1 -name 'financeira-*.sql.gz' -mtime "+${MANTER}" -delete

N=$(ls -1 "$DEST"/financeira-*.sql.gz 2>/dev/null | wc -l)
ULTIMO=$(ls -1t "$DEST"/financeira-*.sql.gz 2>/dev/null | head -1)

if [ -z "$ULTIMO" ]; then
  log "ERRO: nenhum backup no destino apos o rsync."
  exit 1
fi

IDADE=$(( ( $(date +%s) - $(stat -c %Y "$ULTIMO") ) / 86400 ))

# Sem esta checagem, uma producao que parou de gerar backup continuaria
# produzindo "OK" aqui todo dia — a falha so apareceria na hora de restaurar.
if [ "$IDADE" -gt "$ALERTA_DIAS" ]; then
  log "ALERTA: backup mais recente tem ${IDADE} dias. A rotina das 02:30 na producao parou?"
fi

log "OK: ${N} arquivo(s); mais recente $(basename "$ULTIMO") (${IDADE}d)"
