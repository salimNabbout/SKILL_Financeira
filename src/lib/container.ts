/**
 * Composição da aplicação (DI simples).
 * - DEMO_MODE=1: adaptadores em memória + dados fictícios (sem PostgreSQL).
 * - Produção: PostgreSQL via Prisma (fonte oficial dos registros).
 * Singleton em globalThis para sobreviver ao hot-reload do Next em dev.
 */

import { HeuristicClassifier } from "@/core/ai";
import { HashChainAuditTrail } from "@/core/audit";
import { SystemClock } from "@/core/clock";
import { InMemoryEventBus, type EventBus } from "@/core/events";
import { RandomIdGenerator } from "@/core/ids";
import { Orchestrator } from "@/core/orchestrator/orchestrator";
import type { SkillRegistry } from "@/core/orchestrator/registry";
import type { Repositories } from "@/core/repositories";
import type { Integrations } from "@/core/integrations";
import { buildIntegrations } from "@/integrations/registry";
import { buildRegistry } from "@/skills";
import { MemoryDb } from "@/adapters/memory/db";
import { createMemoryRepositories } from "@/adapters/memory/repos";
import { seedDemoData } from "@/adapters/memory/demo-seed";
import { createPrismaRepositories } from "@/adapters/prisma";

export interface AppContainer {
  mode: "demo" | "prisma";
  repos: Repositories;
  events: EventBus;
  audit: HashChainAuditTrail;
  clock: SystemClock;
  ids: RandomIdGenerator;
  ai: HeuristicClassifier;
  integrations: Integrations;
  registry: SkillRegistry;
  orchestrator: Orchestrator;
}

const globalRef = globalThis as unknown as {
  __financeiraContainer?: Promise<AppContainer>;
};

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
}

async function build(): Promise<AppContainer> {
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const ai = new HeuristicClassifier();
  const integrations = buildIntegrations(); // mocks por padrão; reais na v1.2
  const registry = buildRegistry();

  let repos: Repositories;
  let mode: AppContainer["mode"];
  if (isDemoMode()) {
    const db = new MemoryDb();
    repos = createMemoryRepositories(db);
    await seedDemoData(repos, clock);
    mode = "demo";
  } else {
    // Import dinâmico para não exigir o client gerado em modo demo.
    const { PrismaClient } = await import("@prisma/client");
    repos = createPrismaRepositories(new PrismaClient());
    mode = "prisma";
  }

  // Barramento de eventos: in-process com outbox por padrão; em produção,
  // EVENT_BUS=bullmq + REDIS_URL ativam a fila real (worker em processo
  // separado: npx tsx scripts/event-worker.ts).
  let events: EventBus;
  if (mode === "prisma" && process.env.EVENT_BUS === "bullmq" && process.env.REDIS_URL) {
    const { BullMqEventBus } = await import("@/adapters/queue/bullmq-bus");
    events = new BullMqEventBus(repos.events, clock, ids, {
      redisUrl: process.env.REDIS_URL,
    });
  } else {
    events = new InMemoryEventBus(repos.events, clock, ids);
  }
  const audit = new HashChainAuditTrail(repos.audit, clock, ids);
  const orchestrator = new Orchestrator({ repos, events, clock, ids, ai, integrations, registry });

  return { mode, repos, events, audit, clock, ids, ai, integrations, registry, orchestrator };
}

export function getContainer(): Promise<AppContainer> {
  if (!globalRef.__financeiraContainer) {
    globalRef.__financeiraContainer = build();
  }
  return globalRef.__financeiraContainer;
}
