import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O runtime das skills e do orquestrador roda em Node.js (não Edge),
  // pois depende de crypto e, em modo produção, do Prisma.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
