#!/bin/bash
# Cria (ou atualiza a senha da) role RESTRITA que o app e o scheduler usam para
# falar com o Postgres. Rodar UMA VEZ por ambiente, antes de publicar a versão
# que passa a usar APP_DB_USER.
#
# Por que existe: no compose original, `app`, `scheduler` e `migrate` usavam o
# mesmo POSTGRES_USER — que a imagem oficial do Postgres cria como
# SUPERUSUÁRIO. Superusuário ignora GRANT/REVOKE e pode desligar gatilho, então
# o append-only da trilha de auditoria dependia só do gatilho. Com uma role sem
# superpoderes, o REVOKE passa a valer.
#
# Uso, dentro da VPS:
#   /opt/financeira/deploy/criar-role-app.sh
#
# Pré-requisito: APP_DB_USER e APP_DB_PASSWORD preenchidos em deploy/.env.prod.
# Gere a senha com:  openssl rand -base64 24
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${APP_DIR}/deploy/docker-compose.prod.yml"
ENV_FILE="${APP_DIR}/deploy/.env.prod"

dc() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if [ ! -f "$ENV_FILE" ]; then
  echo "!!! ERRO: ${ENV_FILE} não existe. Copie de .env.prod.example e preencha."
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

for var in POSTGRES_USER POSTGRES_DB APP_DB_USER APP_DB_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "!!! ERRO: ${var} não está definida em ${ENV_FILE}."
    echo "    Acrescente APP_DB_USER e APP_DB_PASSWORD (veja .env.prod.example)."
    echo "    Senha:  openssl rand -base64 24"
    exit 1
  fi
done

if [ "$APP_DB_USER" = "$POSTGRES_USER" ]; then
  echo "!!! ERRO: APP_DB_USER é igual a POSTGRES_USER (${POSTGRES_USER})."
  echo "    A role restrita precisa ser OUTRA — senão o app continua superusuário"
  echo "    e o REVOKE da trilha de auditoria não protege nada."
  exit 1
fi

echo "==> 1/3 Criando/atualizando a role '${APP_DB_USER}'…"
# A senha entra como variável do psql (:'senha'), que a escapa como literal —
# não é interpolada no shell nem concatenada em SQL na mão.
dc exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v role_app="$APP_DB_USER" -v senha="$APP_DB_PASSWORD" <<'SQL'
-- CREATE na primeira vez, ALTER nas seguintes: rodar de novo só troca a senha.
-- A role nasce sem SUPERUSER, sem CREATEDB, sem CREATEROLE — só LOGIN.
SELECT format('%s ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_app')
                   THEN 'ALTER' ELSE 'CREATE' END,
              :'role_app', :'senha')
\gexec
SQL

echo "==> 2/3 Aplicando privilégios…"
dc exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v role_app="$APP_DB_USER" < "${APP_DIR}/deploy/sql/grants-app.sql"

echo "==> 3/3 Verificando que a role NAO consegue adulterar a trilha..."
# Conecta COMO a role restrita e tenta um UPDATE proibido, dentro de uma
# transacao abortada. Sem o privilegio de UPDATE, o Postgres recusa no ato --
# independente de haver linhas na tabela. Sucesso aqui = protecao de pe.
saida="$(dc exec -T -e PGPASSWORD="$APP_DB_PASSWORD" db   psql -U "$APP_DB_USER" -d "$POSTGRES_DB" -X 2>&1 <<'SQL' || true
BEGIN;
UPDATE "AuditRecord" SET action = 'tentativa' WHERE id IS NOT NULL;
ROLLBACK;
SQL
)"

if echo "$saida" | grep -qiE "permission denied|append-only"; then
  echo "    OK: bloqueado, como esperado."
else
  echo "!!! ATENCAO: o UPDATE na trilha NAO foi bloqueado. Saida do psql:"
  echo "$saida"
  exit 1
fi

echo ""
echo "✅ Role '${APP_DB_USER}' pronta."
echo "   Agora publique (deploy/publicar.sh) para o app e o scheduler passarem"
echo "   a usar essa credencial."
