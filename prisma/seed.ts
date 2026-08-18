/**
 * Seed do banco PostgreSQL com os dados fictícios de demonstração.
 * Executar: npm run db:seed (ou npx tsx prisma/seed.ts).
 * Requer DATABASE_URL apontando para um Postgres migrado (npm run db:migrate).
 *
 * Imports relativos (sem alias @/): este script roda via tsx fora do Next.
 */

import { Prisma, PrismaClient } from "@prisma/client";

import { seedDemoData, DEMO_COMPANY_ID, DEMO_PASSWORD } from "../src/adapters/memory/demo-seed";
import { createPrismaRepositories } from "../src/adapters/prisma/repos";
import { SystemClock } from "../src/core/clock";

function isConnectionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  // P1001: can't reach database server; P1002: timeout ao conectar.
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === "P1001" || err.code === "P1002")
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const repos = createPrismaRepositories(prisma);
    await seedDemoData(repos, new SystemClock());
    console.log(`Seed concluído: empresa demo "${DEMO_COMPANY_ID}" pronta.`);
    console.log(`Login de demonstração: ana@cafeaurora.com.br / ${DEMO_PASSWORD}`);
  } catch (err) {
    if (isConnectionError(err)) {
      console.error("Não foi possível conectar ao banco de dados.");
      console.error("Verifique a variável DATABASE_URL e suba o banco com: docker compose up -d db");
      console.error(`Detalhe: ${err instanceof Error ? err.message.trim() : String(err)}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("Falha no seed:", err);
  process.exitCode = 1;
});
