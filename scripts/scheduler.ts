/**
 * Agendador de rotinas — processo separado do servidor web (modo PostgreSQL).
 * Executar: DATABASE_URL=... npx tsx scripts/scheduler.ts
 *
 * A cada tique (SCHEDULER_INTERVAL_MS, default 60s) percorre as empresas
 * ativas e dispara os fluxos elegíveis das agendas configuradas
 * (CompanyConfig.schedules; default: bank_sync 6h, daily_summary 7h,
 * dunning_run 8h — horas LOCAIS da empresa).
 *
 * Segurança contra duplicação: cada disparo usa uma chave de idempotência do
 * balde de tempo (src/core/scheduler.ts) — reiniciar o processo e reexecutar
 * no mesmo dia/hora vira replay idempotente do orquestrador, nunca um segundo
 * processamento. Ações sensíveis continuam parando em aprovação humana
 * (a régua de cobrança agenda mensagens, não as envia).
 *
 * Imports relativos: roda via tsx fora do Next.
 */

import { PrismaClient } from "@prisma/client";

import { createPrismaRepositories } from "../src/adapters/prisma/repos";
import { buildAi } from "../src/adapters/ai/registry";
import { SystemClock } from "../src/core/clock";
import { resolveCompanyConfig } from "../src/core/config";
import type { Actor } from "../src/core/entities";
import { InMemoryEventBus } from "../src/core/events";
import { RandomIdGenerator } from "../src/core/ids";
import { Orchestrator } from "../src/core/orchestrator/orchestrator";
import { collectDueJobs } from "../src/core/scheduler";
import { buildIntegrations } from "../src/integrations/registry";
import { buildRegistry } from "../src/skills";

const SCHEDULER_ACTOR: Actor = { type: "system", id: "scheduler" };

async function main(): Promise<void> {
  const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);
  const prisma = new PrismaClient();
  const repos = createPrismaRepositories(prisma);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const events = new InMemoryEventBus(repos.events, clock, ids);
  const orchestrator = new Orchestrator({
    repos,
    events,
    clock,
    ids,
    ai: buildAi(),
    integrations: buildIntegrations(),
    registry: buildRegistry(),
  });

  // Rastro em memória do último disparo (a correção vem da idempotência).
  const lastRuns = new Map<string, string>();
  let stopping = false;

  async function tick(): Promise<void> {
    const nowUtc = clock.now();
    const companies = (await repos.companies.listAll()).filter((c) => c.active);
    for (const company of companies) {
      const config = resolveCompanyConfig(company.config);
      const accounts = await repos.bankAccounts.listAll(company.id);
      const jobs = collectDueJobs({
        schedules: config.schedules,
        companyId: company.id,
        timezone: config.timezone,
        nowUtc,
        lastRuns,
        activeBankAccountIds: accounts.filter((a) => a.active).map((a) => a.id),
      });
      for (const job of jobs) {
        try {
          const res = await orchestrator.execute({
            flow: job.flow,
            companyId: company.id,
            actor: SCHEDULER_ACTOR,
            payload: job.payload,
            idempotencyKey: job.idempotencyKey,
          });
          lastRuns.set(job.lastRunKey, nowUtc.toISOString());
          console.log(
            `[${nowUtc.toISOString()}] ${company.id} ${job.scheduleId} → ${res.status}` +
              (res.idempotent_replay ? " (replay idempotente)" : "") +
              ` [${job.idempotencyKey}]`
          );
        } catch (error) {
          // Falha não derruba o agendador; o disparo volta a ser elegível no
          // próximo tique (sem lastRun) e o balde de idempotência protege.
          console.error(
            `[${nowUtc.toISOString()}] ${company.id} ${job.scheduleId} FALHOU: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
  }

  console.log(
    `Agendador ativo (tique a cada ${Math.round(intervalMs / 1000)}s) — Ctrl+C para encerrar.`
  );
  await tick();
  const timer = setInterval(() => {
    if (!stopping) void tick();
  }, intervalMs);

  const shutdown = async () => {
    stopping = true;
    clearInterval(timer);
    console.log("Encerrando agendador…");
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Falha no agendador:", err);
  process.exit(1);
});
