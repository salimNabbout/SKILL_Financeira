import path from "node:path";
import type { NextConfig } from "next";

// Origens confiáveis para Server Actions atrás de proxy reverso. O Next 15
// compara Host×Origin e recusa a ação se divergirem — atrás de nginx, o FQDN
// pode chegar com ponto final ("dominio.com."), quebrando o login. Listamos o
// domínio (de ALLOWED_ORIGINS, separado por vírgula) com E sem o ponto final.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
  .flatMap((o) => [o, `${o}.`]);

const nextConfig: NextConfig = {
  // Empacotamento self-contained para deploy em container/VPS: o build gera
  // .next/standalone com só o necessário para rodar (node server.js), sem
  // precisar de node_modules completo em produção. Ver Dockerfile.
  output: "standalone",
  // Ancora o tracing na raiz do projeto para que server.js caia sempre em
  // .next/standalone/server.js (sem inferir uma raiz de monorepo pelo caminho).
  outputFileTracingRoot: path.join(process.cwd()),
  ...(allowedOrigins.length > 0
    ? { experimental: { serverActions: { allowedOrigins } } }
    : {}),
  // O runtime das skills e do orquestrador roda em Node.js (não Edge),
  // pois depende de crypto e, em modo produção, do Prisma.
  // bullmq/ioredis ficam fora do bundle: carregados só quando EVENT_BUS=bullmq
  // (o cliente Valkey opcional do bullmq geraria warning de módulo ausente).
  serverExternalPackages: ["@prisma/client", "bullmq", "ioredis"],
};

export default nextConfig;
