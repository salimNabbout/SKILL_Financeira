import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestEnv } from "@/adapters/memory/test-env";
import { SkillRegistry } from "../orchestrator/registry";
import { Orchestrator } from "../orchestrator/orchestrator";
import type { FlowDefinition } from "../orchestrator/flows";
import { makeResult, type SkillDefinition } from "../skill";

/**
 * Skills falsas para testar o motor do orquestrador de forma isolada:
 * - "contas_a_pagar" (fake): cria um contador de execuções e, na ação
 *   "sensitive", pede aprovação humana; quando retomada com aprovação, conclui.
 * - "relatorios_gerenciais" (fake): apenas ecoa.
 */

function buildFakes() {
  const executions: string[] = [];
  let pendingTarget: string | undefined;

  const fakeAp: SkillDefinition = {
    name: "contas_a_pagar",
    responsibility: "fake",
    objective: "fake",
    inputSchema: z.object({ action: z.string() }).passthrough(),
    consumes: [],
    publishes: [],
    dataSources: ["fake"],
    async execute(ctx, input) {
      const action = (input as { action: string }).action;
      executions.push(action);
      if (action === "boom") throw new Error("explodiu");
      if (action === "sensitive") {
        if (ctx.approval?.status === "approved") {
          return makeResult("contas_a_pagar", ctx, {
            executed: true,
            target: pendingTarget,
            decidedBy: ctx.approval.decidedBy,
          });
        }
        if (ctx.approval?.status === "rejected") {
          return makeResult("contas_a_pagar", ctx, { canceled: true });
        }
        pendingTarget = "pay_fake_1";
        return makeResult(
          "contas_a_pagar",
          ctx,
          {
            approvalRequest: {
              targetType: "payment",
              targetId: pendingTarget,
              summary: "Pagamento fake de R$ 100,00",
              amountCents: 10000,
            },
          },
          { status: "awaiting_approval", requiresHumanApproval: true }
        );
      }
      return makeResult("contas_a_pagar", ctx, { echoed: action }, { dataSources: ["fake_db"] });
    },
  };

  const fakeReport: SkillDefinition = {
    name: "relatorios_gerenciais",
    responsibility: "fake",
    objective: "fake",
    inputSchema: z.object({ action: z.string() }).passthrough(),
    consumes: [],
    publishes: [],
    dataSources: [],
    async execute(ctx, input) {
      executions.push((input as { action: string }).action);
      return makeResult("relatorios_gerenciais", ctx, { ok: true });
    },
  };

  const registry = new SkillRegistry();
  registry.register(fakeAp);
  registry.register(fakeReport);
  return { registry, executions };
}

const simpleFlow: FlowDefinition = {
  name: "fake_simple",
  description: "fluxo de teste",
  requiredPermission: "flow.execute",
  steps: [
    {
      id: "s1",
      skill: "contas_a_pagar",
      description: "eco",
      buildInput: (f) => ({ action: f.payload.action ?? "hello" }),
    },
    {
      id: "s2",
      skill: "relatorios_gerenciais",
      description: "relatório",
      buildInput: () => ({ action: "daily" }),
    },
  ],
};

const approvalFlow: FlowDefinition = {
  name: "fake_approval",
  description: "fluxo com aprovação",
  requiredPermission: "flow.execute",
  steps: [
    { id: "s1", skill: "contas_a_pagar", description: "sensível", buildInput: () => ({ action: "sensitive" }) },
    { id: "s2", skill: "relatorios_gerenciais", description: "posterior", buildInput: () => ({ action: "after" }) },
  ],
};

function makeOrchestrator(env: ReturnType<typeof createTestEnv>, registry: SkillRegistry) {
  return new Orchestrator({
    repos: env.repos,
    events: env.events,
    clock: env.clock,
    ids: env.ids,
    ai: env.ai,
    integrations: env.integrations,
    registry,
    flows: new Map([
      [simpleFlow.name, simpleFlow],
      [approvalFlow.name, approvalFlow],
    ]),
  });
}

describe("orquestrador", () => {
  it("executa passos em ordem e consolida resultados", async () => {
    const env = createTestEnv();
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_simple",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { action: "hello" },
    });

    expect(res.status).toBe("completed");
    expect(res.results.map((r) => r.stepId)).toEqual(["s1", "s2"]);
    expect(executions).toEqual(["hello", "daily"]);
    expect(res.consolidated.summary).toContain("concluído");
    expect(res.consolidated.data_sources).toContain("fake_db");

    // Execuções de skill registradas + trilha de auditoria com cadeia válida
    const skillExecs = await env.repos.skillExecutions.list(env.company.id);
    expect(skillExecs).toHaveLength(2);
    const audit = await env.repos.audit.list(env.company.id);
    expect(audit.map((a) => a.action)).toContain("flow.started");
    expect(audit.map((a) => a.action)).toContain("flow.completed");
  });

  it("é idempotente: mesma requisição não reprocessa nem duplica", async () => {
    const env = createTestEnv();
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const req = {
      flow: "fake_simple",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { action: "hello" },
      idempotencyKey: "req-001",
    };
    const first = await orch.execute(req);
    const second = await orch.execute(req);

    expect(second.idempotent_replay).toBe(true);
    expect(second.flowRunId).toBe(first.flowRunId);
    expect(executions.filter((e) => e === "hello")).toHaveLength(1);
  });

  it("rejeita reutilização de chave de idempotência com payload diferente", async () => {
    const env = createTestEnv();
    const { registry } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    await orch.execute({
      flow: "fake_simple",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { action: "hello" },
      idempotencyKey: "req-002",
    });
    await expect(
      orch.execute({
        flow: "fake_simple",
        companyId: env.company.id,
        actor: env.actorFor("analyst"),
        payload: { action: "outro" },
        idempotencyKey: "req-002",
      })
    ).rejects.toThrow(/payload diferente/);
  });

  it("bloqueia usuário sem permissão", async () => {
    const env = createTestEnv();
    const { registry } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    await expect(
      orch.execute({
        flow: "fake_simple",
        companyId: env.company.id,
        actor: env.actorFor("viewer"),
        payload: {},
      })
    ).rejects.toThrow(/permissão/);
  });

  it("suspende para aprovação humana, retoma após aprovação e conclui", async () => {
    const env = createTestEnv();
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_approval",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {},
    });

    expect(res.status).toBe("awaiting_approval");
    expect(res.approval?.status).toBe("pending");
    expect(res.approval?.requiredRole).toBe("approver"); // R$ 100 <= alçada de approver
    expect(executions).not.toContain("after");

    // Aprovador (diferente do solicitante) aprova → fluxo retoma e conclui.
    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("approver"),
      justification: "ok",
    })) as Awaited<ReturnType<typeof orch.execute>>;

    expect(resumed.status).toBe("completed");
    expect(resumed.results.find((r) => r.stepId === "s1")?.result.data).toMatchObject({
      executed: true,
      decidedBy: "usr_approver",
    });
    expect(executions).toContain("after");
  });

  it("impede que o solicitante aprove a própria solicitação (segregação)", async () => {
    const env = createTestEnv();
    const { registry } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_approval",
      companyId: env.company.id,
      actor: env.actorFor("manager"),
      payload: {},
    });

    await expect(
      orch.decideApproval({
        companyId: env.company.id,
        approvalId: res.approval!.id,
        decision: "approved",
        actor: env.actorFor("manager"),
      })
    ).rejects.toThrow(/Segregação/);
  });

  it("rejeição cancela a ação pendente e não executa passos seguintes", async () => {
    const env = createTestEnv();
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_approval",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {},
    });
    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "rejected",
      actor: env.actorFor("approver"),
      justification: "não autorizado",
    })) as Awaited<ReturnType<typeof orch.execute>>;

    expect(resumed.status).toBe("rejected");
    expect(resumed.results.find((r) => r.stepId === "s1")?.result.data).toMatchObject({
      canceled: true,
    });
    expect(executions).not.toContain("after");
  });

  it("falha em passo obrigatório interrompe o fluxo e permite nova tentativa", async () => {
    const env = createTestEnv();
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_simple",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { action: "boom" },
      idempotencyKey: "req-boom",
    });
    expect(res.status).toBe("failed");
    expect(executions).not.toContain("report");

    // Falha não grava idempotência: nova tentativa reexecuta.
    const retry = await orch.execute({
      flow: "fake_simple",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { action: "hello2" },
      idempotencyKey: "req-boom-2",
    });
    expect(retry.status).toBe("completed");
  });
});

describe("orquestrador — dupla aprovação (four-eyes)", () => {
  async function setupDoubleApproval(env: ReturnType<typeof createTestEnv>) {
    // Faixa única exigindo DUAS aprovações (papel mínimo: approver).
    await env.repos.companies.update({
      ...env.company,
      config: {
        approvalTiers: [{ maxAmountCents: null, requiredRole: "approver", approvalsRequired: 2 }],
      },
    });
  }

  it("primeira aprovação é parcial: fluxo segue suspenso até a segunda pessoa aprovar", async () => {
    const env = createTestEnv();
    await setupDoubleApproval(env);
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_approval",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {},
    });
    expect(res.approval?.approvalsRequired).toBe(2);

    // 1ª aprovação (approver): parcial — nada é retomado.
    const first = await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("approver"),
    });
    expect("flowRunId" in first).toBe(false);
    const partial = (first as { approval: (typeof res)["approval"] }).approval!;
    expect(partial.status).toBe("pending");
    expect(partial.approverIds).toEqual(["usr_approver"]);
    expect(executions).not.toContain("after");
    expect(env.db.events.some((e) => e.type === "approval.partially_approved")).toBe(true);
    expect(
      (await env.repos.audit.list(env.company.id)).some(
        (a) => a.action === "approval.partially_approved"
      )
    ).toBe(true);

    // Mesmo aprovador de novo → bloqueado.
    await expect(
      orch.decideApproval({
        companyId: env.company.id,
        approvalId: res.approval!.id,
        decision: "approved",
        actor: env.actorFor("approver"),
      })
    ).rejects.toThrow(/já registrou aprovação/);

    // 2ª aprovação por OUTRA pessoa → decisão final e fluxo retomado.
    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("manager"),
    })) as Awaited<ReturnType<typeof orch.execute>>;

    expect(resumed.status).toBe("completed");
    expect(executions).toContain("after");
    const finalApproval = await env.repos.approvals.getById(env.company.id, res.approval!.id);
    expect(finalApproval?.status).toBe("approved");
    expect(finalApproval?.approverIds).toEqual(["usr_approver", "usr_manager"]);
    expect(finalApproval?.decidedBy).toBe("usr_manager");
  });

  it("uma única rejeição encerra a solicitação mesmo após aprovação parcial", async () => {
    const env = createTestEnv();
    await setupDoubleApproval(env);
    const { registry, executions } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_approval",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {},
    });
    await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("approver"),
    });

    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "rejected",
      actor: env.actorFor("manager"),
      justification: "valor não autorizado",
    })) as Awaited<ReturnType<typeof orch.execute>>;

    expect(resumed.status).toBe("rejected");
    expect(executions).not.toContain("after");
    const finalApproval = await env.repos.approvals.getById(env.company.id, res.approval!.id);
    expect(finalApproval?.status).toBe("rejected");
  });

  it("sem configuração de dupla aprovação, uma única aprovação decide (retrocompatível)", async () => {
    const env = createTestEnv();
    const { registry } = buildFakes();
    const orch = makeOrchestrator(env, registry);

    const res = await orch.execute({
      flow: "fake_approval",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {},
    });
    expect(res.approval?.approvalsRequired).toBe(1);

    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("approver"),
    })) as Awaited<ReturnType<typeof orch.execute>>;
    expect(resumed.status).toBe("completed");
  });
});
