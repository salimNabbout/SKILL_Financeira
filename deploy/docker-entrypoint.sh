#!/bin/sh
# Entrypoint do container do app: aplica migrações pendentes e sobe o servidor.
# As migrações são idempotentes (prisma migrate deploy) — seguro a cada start.
set -e

echo "==> Aplicando migrações (prisma migrate deploy)..."
# Chama o entrypoint REAL da CLI do Prisma (não o symlink .bin/prisma): assim o
# __dirname é prisma/build/ e os arquivos .wasm são resolvidos corretamente.
node ./node_modules/prisma/build/index.js migrate deploy

echo "==> Iniciando o servidor..."
exec "$@"
