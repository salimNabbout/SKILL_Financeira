/**
 * Integração do barramento BullMQ contra um Redis REAL.
 * Roda apenas com REDIS_URL definido (no CI, o job com serviço Redis;
 * localmente: docker compose up -d redis && REDIS_URL=redis://localhost:6379).
 */

import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "@/adapters/memory/db";
import { createMemoryRepositories } from "@/adapters/memory/repos";
import { BullMqEventBus } from "@/adapters/queue/bullmq-bus";
import { SystemClock } from "@/core/clock";
import type { DomainEvent } from "@/core/events";
import { SequentialIdGenerator } from "@/core/ids";

const REDIS_URL = process.env.REDIS_URL;

function makeBus(queueName: string, opts?: { attempts?: number; backoffMs?: number }) {
  const db = new MemoryDb();
  const repos = createMemoryRepositories(db);
  const bus = new BullMqEventBus(repos.events, new SystemClock(), new SequentialIdGenerator(), {
    redisUrl: REDIS_URL!,
    queueName,
    attempts: opts?.attempts ?? 3,
    backoffMs: opts?.backoffMs ?? 50,
  });
  return { db, repos, bus };
}

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  return waitForAsync(async () => check(), timeoutMs);
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout aguardando condição");
}

const buses: BullMqEventBus[] = [];
afterEach(async () => {
  for (const bus of buses.splice(0)) {
    await bus.obliterate().catch(() => undefined);
    await bus.close().catch(() => undefined);
  }
});

describe.skipIf(!REDIS_URL)("BullMqEventBus (Redis real)", () => {
  it("publica com outbox no banco e o worker consome e despacha", async () => {
    const { db, bus } = makeBus(`t-consume-${process.pid}-${Date.now()}`);
    buses.push(bus);
    const received: DomainEvent[] = [];
    bus.subscribe("payable.created", (e) => {
      received.push(e);
    });
    bus.startWorker(1);

    await bus.publish({
      companyId: "co_teste",
      type: "payable.created",
      payload: { payableId: "pay_1", amountCents: 1000 },
      source: "teste",
      correlationId: "corr_1",
    });

    // Outbox gravado ANTES do consumo (fonte oficial independe do Redis).
    expect(db.events).toHaveLength(1);
    expect(db.events[0].type).toBe("payable.created");

    await waitFor(() => received.length === 1);
    expect(received[0].payload).toMatchObject({ payableId: "pay_1" });
    expect(received[0].correlationId).toBe("corr_1");
  });

  it("re-tenta com backoff quando o handler falha e conclui na tentativa seguinte", async () => {
    const { bus } = makeBus(`t-retry-${process.pid}-${Date.now()}`);
    buses.push(bus);
    let calls = 0;
    bus.subscribe("*", () => {
      calls++;
      if (calls === 1) throw new Error("falha transitória simulada");
    });
    bus.startWorker(1);

    await bus.publish({
      companyId: "co_teste",
      type: "cashflow.updated",
      payload: {},
      source: "teste",
      correlationId: "corr_retry",
    });

    await waitFor(() => calls >= 2);
    expect(calls).toBe(2); // 1ª falhou, 2ª (retry) concluiu
    expect(await bus.failedCount()).toBe(0);
  });

  it("esgotadas as tentativas, o evento permanece na fila morta (failed)", async () => {
    const { bus } = makeBus(`t-dlq-${process.pid}-${Date.now()}`, { attempts: 2 });
    buses.push(bus);
    let calls = 0;
    bus.subscribe("*", () => {
      calls++;
      throw new Error("falha permanente simulada");
    });
    bus.startWorker(1);

    await bus.publish({
      companyId: "co_teste",
      type: "alert.raised",
      payload: {},
      source: "teste",
      correlationId: "corr_dlq",
    });

    await waitFor(() => calls >= 2);
    await waitForAsync(async () => (await bus.failedCount()) === 1);
    expect(calls).toBe(2); // exatamente as 2 tentativas configuradas
  });
});
