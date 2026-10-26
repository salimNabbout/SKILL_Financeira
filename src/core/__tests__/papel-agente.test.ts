/**
 * Papel `integration_agent`: conta de serviço dos agentes (leitura de e-mail -> título em Contas a Pagar).
 * Precisa conseguir CRIAR título pelo fluxo de nota de fornecedor e nada além disso: pagar, aprovar, cancelar e
 * cadastrar continuam sendo de pessoas.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { buildRegistry } from "@/skills";
import { ASSIGNABLE_ROLES } from "@/lib/user-admin";
import { hasPermission, roleAtLeast, type Permission } from "../auth";
import type { Actor } from "../entities";
import type { Orchestrator } from "../orchestrator/orchestrator";

let env: TestEnv;
let orch: Orchestrator;
const agente: Actor = { type: "user", id: "usr_agente", role: "integration_agent" };

beforeEach(async () => {
  env = createTestEnv("2026-08-18T15:00:00Z");
  orch = env.orchestrator(buildRegistry());
  const now = env.clock.now().toISOString();
  await env.repos.suppliers.create({
    id: "sup_1", companyId: env.company.id, name: "Torrefação Boa Vista", document: "22.333.444/0001-55",
    active: true, createdAt: now, updatedAt: now,
  });
  await env.repos.categories.create({
    id: "cat_insumos", companyId: env.company.id, name: "Insumos e mercadorias", kind: "expense", dreGroup: "custos", active: true,
  });
});

const payload = {
  supplierId: "sup_1",
  description: "NF 8841 — café verde",
  issueDate: "2026-08-10",
  dueDate: "2026-09-10",
  amountCents: 500_000,
  categoryId: "cat_insumos",
};

describe("papel integration_agent", () => {
  it("cria título pelo fluxo de nota de fornecedor, e a mesma requisição não duplica", async () => {
    const req = { flow: "supplier_invoice_intake", companyId: env.company.id, actor: agente, payload, idempotencyKey: "agente-nf-8841" };
    const first = await orch.execute(req);
    expect(first.status).toBe("completed");
    expect(await env.repos.payables.listAll(env.company.id)).toHaveLength(1);

    const second = await orch.execute(req);
    expect(second.idempotent_replay).toBe(true);
    expect(await env.repos.payables.listAll(env.company.id)).toHaveLength(1);
  });

  it("o título nasce em aberto e sem nenhuma liquidação: pagar continua dependendo de pessoas", async () => {
    await orch.execute({ flow: "supplier_invoice_intake", companyId: env.company.id, actor: agente, payload });
    const [titulo] = await env.repos.payables.listAll(env.company.id);
    expect(titulo.status).toBe("open");
    expect(titulo.paidCents ?? 0).toBe(0);
  });

  it.each<Permission>([
    "payment.request", "payment.approve", "payment.execute", "payable.cancel", "master_data.manage", "bank_account.manage",
    "receivable.create", "receivable.settle", "reconciliation.manage", "accounting.export", "user.manage", "company.manage", "audit.view",
  ])("não tem a permissão %s", (permissao) => {
    expect(hasPermission("integration_agent", permissao)).toBe(false);
  });

  it("tem só criar título, consultar e executar fluxo", () => {
    for (const p of ["payable.create", "report.view", "flow.execute"] as Permission[]) {
      expect(hasPermission("integration_agent", p)).toBe(true);
    }
  });

  it("não vale como aprovador em nenhuma alçada", () => {
    expect(roleAtLeast("integration_agent", "approver")).toBe(false);
    expect(roleAtLeast("integration_agent", "finance_analyst")).toBe(false);
  });

  it("pode ser atribuído pelo cadastro de usuários", () => {
    expect(ASSIGNABLE_ROLES).toContain("integration_agent");
  });

  it("fornecedor que não existe barra a criação (o agente não cadastra fornecedor)", async () => {
    const res = await orch.execute({
      flow: "supplier_invoice_intake", companyId: env.company.id, actor: agente, payload: { ...payload, supplierId: "sup_inexistente" },
    });
    expect(res.status).toBe("failed");
    expect(await env.repos.payables.listAll(env.company.id)).toHaveLength(0);
  });
});
