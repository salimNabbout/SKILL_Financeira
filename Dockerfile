# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Imagem de produção do app (Next.js standalone). As MIGRAÇÕES rodam num serviço
# à parte (target `migrate`, com node_modules completo) — a imagem do app fica
# enxuta e sem a CLI do Prisma. Ver deploy/docker-compose.prod.yml e README.md.
# ---------------------------------------------------------------------------

# --- Stage 1: dependências (com devDeps, para buildar e para migrar) --------
FROM node:22-alpine AS deps
WORKDIR /app
# openssl é exigido pelo engine do Prisma no Alpine.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall roda `prisma generate` — precisa do schema (copiado acima).
RUN npm ci

# --- Stage 2: build --------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DEMO_MODE=1 só para o build não exigir DATABASE_URL na etapa de build.
# Em runtime o app roda com DEMO_MODE vazio (produção real, ver compose).
ENV NEXT_TELEMETRY_DISABLED=1
RUN DEMO_MODE=1 npm run build

# --- Stage 3a: migrate (node_modules completo → Prisma CLI funciona) --------
# Usado pelo serviço `migrate` do compose: roda `prisma migrate deploy` e sai.
FROM node:22-alpine AS migrate
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
COPY package.json tsconfig.json ./
# src/ e scripts/ para rodar utilitários pontuais (ex.: criar admin real)
# além das migrações. Ver scripts/create-admin.ts e deploy/README.md.
COPY src ./src
COPY scripts ./scripts
CMD ["npx", "prisma", "migrate", "deploy"]

# --- Stage 3b: runner (imagem final enxuta, só o app) ----------------------
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Usuário sem privilégios.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Saída standalone do Next: server.js + o mínimo de node_modules.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# (Este projeto não tem pasta public/. Se adicionar assets estáticos lá,
#  descomente: COPY --from=build /app/public ./public)

RUN chown -R nextjs:nodejs /app
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
