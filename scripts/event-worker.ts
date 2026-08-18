/**
 * Worker de eventos (BullMQ/Redis) — processo separado do servidor web.
 * Executar: REDIS_URL=redis://localhost:6379 npx tsx scripts/event-worker.ts
 *
 * Consome a fila "financeira-eventos" e despacha aos handlers registrados.
 * No MVP as reações de negócio são materializadas pelos fluxos do orquestrador;
 * este worker entrega a infraestrutura (retry, backoff, fila morta) e um
 * handler de observabilidade. Novas reações assíncronas registram-se aqui.
 *
 * Imports relativos: roda via tsx fora do Next.
 */

import { PrismaClient } from "@prisma/client";

import { createPrismaRepositories } from "../src/adapters/prisma/repos";
import { BullMqEventBus } from "../src/adapters/queue/bullmq-bus";
import { SystemClock } from "../src/core/clock";
import { RandomIdGenerator } from "../src/core/ids";

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error("Defina REDIS_URL (ex.: redis://localhost:6379).");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const repos = createPrismaRepositories(prisma);
  const bus = new BullMqEventBus(repos.events, new SystemClock(), new RandomIdGenerator(), {
    redisUrl,
  });

  let processed = 0;
  bus.subscribe("*", (event) => {
    processed++;
    console.log(
      `[${new Date().toISOString()}] #${processed} ${event.type} empresa=${event.companyId} corr=${event.correlationId}`
    );
  });

  const worker = bus.startWorker();
  worker.on("failed", (job, err) => {
    console.error(`Job ${job?.id} (${job?.name}) falhou: ${err.message}`);
  });
  console.log(`Worker de eventos ativo na fila "${bus.queueName}" — Ctrl+C para encerrar.`);

  const shutdown = async () => {
    console.log("Encerrando worker…");
    await bus.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Falha no worker de eventos:", err);
  process.exit(1);
});
