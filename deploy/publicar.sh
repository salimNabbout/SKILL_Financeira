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

# Aviso: sem a role restrita, o app roda como dono do banco (superusuario), e o
# REVOKE da trilha de auditoria nao protege nada. O FALLBACK esta no compose,
# nao aqui -- uma protecao que mora neste script so vale na publicacao SEGUINTE
# aquela que a torna necessaria, porque o bash ja carregou a versao antiga.
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
if [ -z "${APP_DB_USER:-}" ]; then
  echo "!!! AVISO: APP_DB_USER ausente em ${ENV_FILE}."
  echo "    O app vai rodar como ${POSTGRES_USER}, que e SUPERUSUARIO."
  echo "    Para endurecer: ${APP_DIR}/deploy/criar-role-app.sh"
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
# APP_DB_USER pode nao existir no .env.prod (o fallback vive no compose), e o
# script roda com `set -u`: a referencia PRECISA do default, senao aborta o
# deploy depois de ja ter recriado os containers.
dc exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"   -v role_app="${APP_DB_USER:-financeira_app}" < "${APP_DIR}/deploy/sql/grants-app.sql" >/dev/null

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

echo "==> 6/6 Conferindo que o app fala com o banco…"
# /login responde 200 sem tocar no banco: sozinho ele NAO detecta credencial
# invalida (ja deixou passar uma URL sem usuario nem senha). O audit-anchor le a
# trilha inteira e verifica a cadeia de hash, com as mesmas credenciais do app.
if ! dc exec -T scheduler npx tsx scripts/audit-anchor.ts; then
  echo "!!! ERRO: o app nao conseguiu ler a trilha de auditoria no banco."
  echo "    Confira a DATABASE_URL:"
  echo "    dc exec -T app printenv DATABASE_URL"
  exit 1
fi

echo "==> Status dos containers:"
dc ps

echo ""
echo "✅ Publicado com sucesso."
echo "   ${COMMIT}"
echo "   App respondendo em ${URL} (200)."
