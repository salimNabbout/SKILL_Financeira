#!/usr/bin/env bash
#
# Deploy em produção (PostgreSQL real). Valida o ambiente ANTES de tocar no
# banco, aplica as migrações pendentes e faz o build. Idempotente e seguro para
# reexecutar. Ver docs/DEPLOY.md para o checklist completo.
#
# Uso:
#   ./scripts/deploy.sh            # instala, valida, migra e builda
#   ./scripts/deploy.sh --seed     # idem + carga de demonstração (SÓ em banco vazio)
#
set -euo pipefail

SEED=false
[[ "${1:-}" == "--seed" ]] && SEED=true

fail() { echo "ERRO: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# --- 1. Pré-condições de ambiente ------------------------------------------
info "Validando ambiente..."

command -v node >/dev/null || fail "Node.js não encontrado."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node.js 22+ exigido (encontrado: $(node -v))."

[[ "${NODE_ENV:-}" == "production" ]] || fail "NODE_ENV deve ser 'production' (atual: '${NODE_ENV:-vazio}')."

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL não definida (aponte para o PostgreSQL de produção)."

[[ -n "${SESSION_SECRET:-}" ]] || fail "SESSION_SECRET não definida. Gere: openssl rand -base64 48"
[[ "${SESSION_SECRET}" != "TROQUE-POR-UM-SEGREDO-ALEATORIO-FORTE" ]] \
  || fail "SESSION_SECRET ainda é o placeholder. Gere: openssl rand -base64 48"
[[ "${SESSION_SECRET}" != "dev-secret-change-me-0123456789abcdef" ]] \
  || fail "SESSION_SECRET é o valor de desenvolvimento. Gere um segredo real."

# DEMO_MODE não pode estar ativo em produção (rodaria em memória, perde dados).
if [[ "${DEMO_MODE:-}" == "1" || "${DEMO_MODE:-}" == "true" ]]; then
  fail "DEMO_MODE está ativo — desative em produção (o app rodaria em memória)."
fi

# Se a IA real está ligada, a chave é obrigatória (senão o app falha no boot).
if [[ "${AI_PROVIDER:-mock}" == "anthropic" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  fail "AI_PROVIDER=anthropic exige ANTHROPIC_API_KEY."
fi

# Se a fila real está ligada, a URL do Redis é obrigatória.
if [[ "${EVENT_BUS:-}" == "bullmq" && -z "${REDIS_URL:-}" ]]; then
  fail "EVENT_BUS=bullmq exige REDIS_URL."
fi

info "Ambiente OK."

# --- 2. Dependências --------------------------------------------------------
info "Instalando dependências (npm ci)..."
npm ci

# --- 3. Migrações (idempotente) --------------------------------------------
info "Aplicando migrações pendentes (prisma migrate deploy)..."
npm run db:migrate

# --- 4. Seed opcional (apenas em banco vazio) ------------------------------
if $SEED; then
  info "Rodando seed de demonstração (--seed)..."
  echo "    ATENÇÃO: só use em banco vazio; não rode sobre dados reais."
  npm run db:seed
fi

# --- 5. Build ---------------------------------------------------------------
info "Buildando a aplicação (next build)..."
npm run build

info "Deploy preparado com sucesso."
echo ""
echo "Próximos passos:"
echo "  - Suba a aplicação:        npm run start   (atrás de proxy HTTPS)"
echo "  - Agendador (opcional):    npx tsx scripts/scheduler.ts"
echo "  - Worker BullMQ (se usar): npx tsx scripts/event-worker.ts"
echo "  - Verificação pós-deploy:  ver docs/DEPLOY.md §4"
