import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O runtime das skills e do orquestrador roda em Node.js (não Edge),
  // pois depende de crypto e, em modo produção, do Prisma.
  // bullmq/ioredis ficam fora do bundle: carregados só quando EVENT_BUS=bullmq
  // (o cliente Valkey opcional do bullmq geraria warning de módulo ausente).
  serverExternalPackages: ["@prisma/client", "bullmq", "ioredis"],
};

export default nextConfig;
