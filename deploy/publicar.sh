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

# Credenciais da role restrita do app. Se ainda nao existirem no .env.prod, cai
# no usuario dono do banco e AVISA: o deploy continua funcionando, so nao esta
# endurecido ainda. Variavel exportada tem precedencia sobre o --env-file.
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
if [ -z "${APP_DB_USER:-}" ] || [ -z "${APP_DB_PASSWORD:-}" ]; then
  export APP_DB_USER="${POSTGRES_USER}"
  export APP_DB_PASSWORD="${POSTGRES_PASSWORD}"
  echo "!!! AVISO: APP_DB_USER/APP_DB_PASSWORD ausentes em ${ENV_FILE}."
  echo "    O app vai rodar como ${POSTGRES_USER}, que e SUPERUSUARIO -- o"
  echo "    REVOKE da trilha de auditoria nao protege nada nessa condicao."
  echo "    Para corrigir: preencha os dois no .env.prod e rode"
  echo "    ${APP_DIR}/deploy/criar-role-app.sh"
  echo ""
fi

echo "==> 1/6 Atualizando código (git)…"
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main
COMMIT="$(git log --oneline -1)"
echo "    Código em: ${COMMIT}"

echo "==> 2/6 Construindo imagens (app + migrate + scheduler)…"
# Rebuilda as três: se houver migração nova, ela entra na imagem migrate; o
# scheduler roda o código novo (recorrência e demais rotinas).
dc build app migrate scheduler

echo "==> 3/6 Recriando os containers (app + scheduler)…"
# O app/scheduler dependem de 'migrate' (service_completed_successfully): o
# compose roda a migração pendente automaticamente antes de subir.
dc up -d --force-recreate app scheduler

echo "==> 4/6 Reaplicando privilegios da role restrita…"
# Idempotente, e NO-OP silencioso quando a role ainda nao existe. Roda depois da
# migration: tabela nova precisa nascer acessivel para a role do app. O
# ALTER DEFAULT PRIVILEGES ja cobre isso, este passo e a rede de seguranca.
dc exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"   -v role_app="$APP_DB_USER" < "${APP_DIR}/deploy/sql/grants-app.sql" >/dev/null

echo "==> 5/6 Aguardando o app responder…"
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

echo "==> 6/6 Status dos containers:"
dc ps

echo ""
echo "✅ Publicado com sucesso."
echo "   ${COMMIT}"
echo "   App respondendo em ${URL} (200)."
