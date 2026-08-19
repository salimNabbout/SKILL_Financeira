import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Empacotamento self-contained para deploy em container/VPS: o build gera
  // .next/standalone com só o necessário para rodar (node server.js), sem
  // precisar de node_modules completo em produção. Ver Dockerfile.
  output: "standalone",
  // Ancora o tracing na raiz do projeto para que server.js caia sempre em
  // .next/standalone/server.js (sem inferir uma raiz de monorepo pelo caminho).
  outputFileTracingRoot: path.join(process.cwd()),
  // O runtime das skills e do orquestrador roda em Node.js (não Edge),
  // pois depende de crypto e, em modo produção, do Prisma.
  // bullmq/ioredis ficam fora do bundle: carregados só quando EVENT_BUS=bullmq
  // (o cliente Valkey opcional do bullmq geraria warning de módulo ausente).
  serverExternalPackages: ["@prisma/client", "bullmq", "ioredis"],
};

export default nextConfig;
