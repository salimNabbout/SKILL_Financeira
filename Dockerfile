# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Imagem de produção do app (Next.js standalone + Prisma). Ver deploy/README.md.
# Build:  docker build -t financeira-pme .
# ---------------------------------------------------------------------------

# --- Stage 1: dependências (com devDeps, para buildar) ---------------------
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

# --- Stage 3: runner (imagem final enxuta) ---------------------------------
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

# Prisma: pacote CLI (com os .wasm) + engines + client + migrações, para rodar
# `prisma migrate deploy` no start. NÃO copiamos o symlink .bin/prisma: ele
# reloca o __dirname e a CLI não acha os .wasm. O entrypoint chama o entrypoint
# real do pacote (prisma/build/index.js), que resolve os .wasm ao lado dele.
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma

# Entrypoint: aplica migrações e sobe o servidor.
COPY deploy/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
