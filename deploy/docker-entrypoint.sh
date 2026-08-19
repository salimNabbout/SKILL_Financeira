#!/bin/sh
# Entrypoint do container do app: aplica migrações pendentes e sobe o servidor.
# As migrações são idempotentes (prisma migrate deploy) — seguro a cada start.
set -e

echo "==> Aplicando migrações (prisma migrate deploy)..."
./node_modules/.bin/prisma migrate deploy

echo "==> Iniciando o servidor..."
exec "$@"
