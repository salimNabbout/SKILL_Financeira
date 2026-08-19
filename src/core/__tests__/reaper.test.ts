import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import type { FlowRun } from "@/core/entities";
import { reapStuckFlowRuns } from "../orchestrator/reaper";

function seedFlowRun(env: ReturnType<typeof createTestEnv>, over: Partial<FlowRun>): Promise<FlowRun> {
  const now = env.clock.now().toISOString();
  return env.repos.flowRuns.create({
    id: over.id ?? "flow_x",
    companyId: env.company.id,
    flow: "schedule_payment",
    status: "running",
    cursor: 0,
    payload: {},
    results: [],
    idempotencyKey: over.id ?? "flow_x",
    correlationId: "corr_x",
    requestedBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe("reapStuckFlowRuns", () => {
  it("marca como 'failed' flowRuns 'running' mais antigos que o limite", async () => {
    const env = createTestEnv();
    await seedFlowRun(env, { id: "flow_velho", updatedAt: "2026-08-18T14:00:00Z" }); // 1h atrás

    // Agora = 15:00; limite de 30min → o de 14:00 é velho.
    const now = new Date("2026-08-18T15:00:00Z").getTime();
    const reaped = await reapStuckFlowRuns(env.repos, env.company.id, now, {
      olderThanMs: 30 * 60_000,
    });

    expect(reaped).toBe(1);
    const fr = await env.repos.flowRuns.getById(env.company.id, "flow_velho");
    expect(fr?.status).toBe("failed");
  });

  it("NÃO toca flowRuns recentes nem os aguardando aprovação", async () => {
    const env = createTestEnv();
    await seedFlowRun(env, { id: "flow_recente", updatedAt: "2026-08-18T14:50:00Z" }); // 10min
    await seedFlowRun(env, {
      id: "flow_aprovacao",
      status: "awaiting_approval",
      updatedAt: "2026-08-18T10:00:00Z", // muito antigo, mas legitimamente suspenso
    });

    const now = new Date("2026-08-18T15:00:00Z").getTime();
    const reaped = await reapStuckFlowRuns(env.repos, env.company.id, now, {
      olderThanMs: 30 * 60_000,
    });

    expect(reaped).toBe(0);
    expect((await env.repos.flowRuns.getById(env.company.id, "flow_recente"))?.status).toBe(
      "running"
    );
    expect((await env.repos.flowRuns.getById(env.company.id, "flow_aprovacao"))?.status).toBe(
      "awaiting_approval"
    );
  });

  it("não altera flowRuns já concluídos", async () => {
    const env = createTestEnv();
    await seedFlowRun(env, {
      id: "flow_ok",
      status: "completed",
      updatedAt: "2026-08-18T10:00:00Z",
    });
    const now = new Date("2026-08-18T15:00:00Z").getTime();
    const reaped = await reapStuckFlowRuns(env.repos, env.company.id, now, {
      olderThanMs: 30 * 60_000,
    });
    expect(reaped).toBe(0);
  });
});
