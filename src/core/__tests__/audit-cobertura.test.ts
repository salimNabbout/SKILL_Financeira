/**
 * Escritas que aconteciam SEM registro na trilha. Cada caso aqui é uma ação
 * sensível que, até então, não deixava rastro nenhum.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { FlowRun, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { reapStuckFlowRuns } from "@/core/orchestrator/reaper";
import { contasAReceberSkill } from "@/skills/contas-a-receber";

const TODAY = "2026-08-18";

function seedFlowRun(env: TestEnv, over: Partial<FlowRun> = {}): FlowRun {
  const now = env.clock.now().toISOString();
  const flowRun: FlowRun = {
    id: "flow_preso",
    companyId: env.company.id,
    flow: "schedule_payment",
    status: "running",
    cursor: 0,
    payload: {},
    results: [],
    idempotencyKey: "k1",
    correlationId: "corr_1",
    requestedBy: "usr_analyst",
    createdAt: now,
    // Parado há 1 hora (limite do reaper no teste: 30 min).
    updatedAt: "2026-08-18T14:00:00.000Z",
    ...over,
  };
  env.db.flowRuns.push(flowRun);
  return flowRun;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> = {}): Receivable {
  const now = env.clock.now().toISOString();
  env.db.customers.push({
    id: "cus_1",
    companyId: env.company.id,
    name: "Cliente Beta Ltda",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  const r: Receivable = {
    id: "rcv_1",
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Serviço prestado",
    issueDate: "2026-08-01",
    dueDate: "2026-08-25",
    amountCents: 100_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: "seed:rcv_1:1/1",
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.receivables.push(r);
  return r;
}

describe("cobertura da trilha — escritas que passavam sem registro", () => {
  it("reaper: flowRun running → failed deixa rastro com ator de sistema", async () => {
    const env = createTestEnv();
    const flowRun = seedFlowRun(env);

    const reaped = await reapStuckFlowRuns(
      env.repos,
      env.company.id,
      env.clock.now().getTime(),
      { olderThanMs: 30 * 60_000 },
      env.audit
    );

    expect(reaped).toBe(1);
    const registro = env.db.auditRecords.find((a) => a.action === "flow.reaped");
    expect(registro).toBeDefined();
    expect(registro?.entityId).toBe(flowRun.id);
    expect(registro?.actorType).toBe("system");
    expect(registro?.actorId).toBe("scheduler");
    // before/after mostram a transição, que é a informação que faltava.
    expect((registro?.before as FlowRun).status).toBe("running");
    expect((registro?.after as FlowRun).status).toBe("failed");
  });

  it("reaper sem trilha continua funcionando (audit é opcional)", async () => {
    const env = createTestEnv();
    seedFlowRun(env);

    const reaped = await reapStuckFlowRuns(env.repos, env.company.id, env.clock.now().getTime(), {
      olderThanMs: 30 * 60_000,
    });

    expect(reaped).toBe(1);
    expect(env.db.auditRecords.filter((a) => a.action === "flow.reaped")).toHaveLength(0);
  });

  it("recibo manual registra receipt.created com método, principal e encargos", async () => {
    const env = createTestEnv();
    const receivable = seedReceivable(env, { dueDate: "2026-08-01" }); // vencido

    const res = await runSkill(contasAReceberSkill, env.ctx(env.actorFor("manager")), {
      action: "register_receipt",
      receivableId: receivable.id,
      amountCents: 100_000,
      receivedDate: TODAY,
      method: "pix",
    });
    expect(res.status).toBe("success");

    const registro = env.db.auditRecords.find((a) => a.action === "receipt.created");
    expect(registro).toBeDefined();
    expect(registro?.entityType).toBe("receipt");
    const depois = registro?.after as Record<string, unknown>;
    expect(depois.method).toBe("pix");
    expect(depois.principalCents).toBe(100_000);
    expect(depois).toHaveProperty("chargesCents");
    // O registro do TÍTULO continua existindo, com before/after.
    expect(env.db.auditRecords.some((a) => a.action === "receivable.receipt_registered")).toBe(true);
  });

  it("documento fiscal criado no lançamento deixa rastro", async () => {
    const env = createTestEnv();
    const now = env.clock.now().toISOString();
    env.db.suppliers.push({
      id: "sup_1",
      companyId: env.company.id,
      name: "Fornecedora Alfa Ltda",
      document: "11.222.333/0001-44",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    env.db.categories.push({
      id: "cat_1",
      companyId: env.company.id,
      name: "Serviços",
      kind: "expense",
      dreGroup: "despesas_operacionais",
      active: true,
    });

    const { contasAPagarSkill } = await import("@/skills/contas-a-pagar");
    const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("manager")), {
      action: "create_payable",
      supplierId: "sup_1",
      description: "NF 1234",
      issueDate: "2026-08-01",
      dueDate: "2026-08-30",
      amountCents: 50_000,
      categoryId: "cat_1",
      document: {
        type: "nfe",
        number: "1234",
        issuedAt: "2026-08-01",
        totalCents: 50_000,
      },
    });
    expect(res.status).toBe("success");

    const registro = env.db.auditRecords.find((a) => a.action === "document.created");
    expect(registro).toBeDefined();
    expect(registro?.entityType).toBe("document");
    expect((registro?.after as Record<string, unknown>).number).toBe("1234");
  });
});
