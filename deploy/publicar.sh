#!/bin/bash
# Publica a versão mais recente do main em produção, na VPS.
#
# Uso (da sua máquina, com o atalho SSH "financeira" configurado):
#   ssh financeira "/opt/financeira/deploy/publicar.sh"
# Ou, já dentro da VPS:
#   /opt/financeira/deploy/publicar.sh
#
# Faz: pull do main -> build (app + migrate) -> recria o app (aplica migração
# pendente automaticamente, pois o app depende do serviço migrate) -> verifica
# que o app responde. Para com erro claro se qualquer passo falhar.
set -euo pipefail

APP_DIR="/opt/financeira"
COMPOSE_FILE="${APP_DIR}/deploy/docker-compose.prod.yml"
ENV_FILE="${APP_DIR}/deploy/.env.prod"

dc() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

echo "==> 1/5 Atualizando código (git)…"
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main
COMMIT="$(git log --oneline -1)"
echo "    Código em: ${COMMIT}"

echo "==> 2/5 Construindo imagens (app + migrate + scheduler)…"
# Rebuilda as três: se houver migração nova, ela entra na imagem migrate; o
# scheduler roda o código novo (recorrência e demais rotinas).
dc build app migrate scheduler

echo "==> 3/5 Recriando os containers (app + scheduler)…"
# O app/scheduler dependem de 'migrate' (service_completed_successfully): o
# compose roda a migração pendente automaticamente antes de subir.
dc up -d --force-recreate app scheduler

echo "==> 4/5 Aguardando o app responder…"
# Porta local do app (do .env.prod); default 3000 se não definida.
APP_PORT="$(grep -E '^APP_PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')"
APP_PORT="${APP_PORT:-3000}"
URL="http://127.0.0.1:${APP_PORT}/login"

ok=""
for i in $(seq 1 20); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    ok="1"
    break
  fi
  sleep 1
done

if [ -z "$ok" ]; then
  echo "!!! ERRO: app não respondeu 200 em ${URL} (último código: ${code:-?})."
  echo "    Veja os logs: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs --tail 40 app"
  exit 1
fi

echo "==> 5/5 Status dos containers:"
dc ps

echo ""
echo "✅ Publicado com sucesso."
echo "   ${COMMIT}"
echo "   App respondendo em ${URL} (200)."
