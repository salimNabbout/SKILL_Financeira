/**
 * Caminho único de criação de alerta: dedupe e trilha andam juntos.
 *
 * Dez pontos do sistema criavam alerta direto no repositório e só dois
 * registravam `alert.created` — a maior parte do painel de pendências nascia
 * sem rastro.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { persistAlert } from "@/core/alerts";
import { runSkill } from "@/core/skill";
import { contasAPagarSkill } from "@/skills/contas-a-pagar";

function deps(env: ReturnType<typeof createTestEnv>) {
  return {
    companyId: env.company.id,
    actor: env.actorFor("manager"),
    repos: env.repos,
    audit: env.audit,
    clock: env.clock,
    ids: env.ids,
    correlationId: "corr_test",
  };
}

const ALERTA = {
  severity: "warning" as const,
  code: "payable_due_soon",
  message: "Título vence amanhã.",
  entityType: "payable",
  entityId: "payb_1",
};

describe("persistAlert", () => {
  it("cria o alerta E registra alert.created na trilha", async () => {
    const env = createTestEnv();

    const criado = await persistAlert(deps(env), ALERTA, "contas_a_pagar");

    expect(criado).toBeDefined();
    expect(env.db.alerts).toHaveLength(1);
    expect(env.db.alerts[0]).toMatchObject({
      code: "payable_due_soon",
      status: "open",
      source: "contas_a_pagar",
    });
    const registro = env.db.auditRecords.find((a) => a.action === "alert.created");
    expect(registro).toBeDefined();
    expect(registro?.entityType).toBe("alert");
    expect(registro?.entityId).toBe(criado!.id);
  });

  it("dedupe: alerta aberto com mesmo code+entityId não é recriado nem auditado", async () => {
    const env = createTestEnv();

    await persistAlert(deps(env), ALERTA, "contas_a_pagar");
    const segundo = await persistAlert(deps(env), ALERTA, "contas_a_pagar");

    expect(segundo).toBeUndefined();
    expect(env.db.alerts).toHaveLength(1);
    // Nada escrito ⇒ nada auditado (senão a trilha mentiria sobre o painel).
    expect(env.db.auditRecords.filter((a) => a.action === "alert.created")).toHaveLength(1);
  });

  it("code diferente OU entidade diferente gera alerta novo", async () => {
    const env = createTestEnv();

    await persistAlert(deps(env), ALERTA, "contas_a_pagar");
    await persistAlert(deps(env), { ...ALERTA, code: "payable_overdue" }, "contas_a_pagar");
    await persistAlert(deps(env), { ...ALERTA, entityId: "payb_2" }, "contas_a_pagar");

    expect(env.db.alerts).toHaveLength(3);
    expect(env.db.auditRecords.filter((a) => a.action === "alert.created")).toHaveLength(3);
  });

  it("alerta nascido dentro de uma skill também é auditado", async () => {
    const env = createTestEnv();
    const now = env.clock.now().toISOString();
    env.db.suppliers.push({
      id: "sup_1",
      companyId: env.company.id,
      name: "Fornecedora Alfa Ltda",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    env.db.payables.push({
      id: "payb_venc",
      companyId: env.company.id,
      supplierId: "sup_1",
      description: "Vence hoje",
      issueDate: "2026-08-01",
      dueDate: "2026-08-18",
      amountCents: 50_000,
      paidCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "seed:payb_venc:1/1",
      createdBy: "usr_analyst",
      createdAt: now,
      updatedAt: now,
    });

    const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("manager")), {
      action: "list_due",
      withinDays: 7,
    });

    // A skill devolve "warning" justamente por ter gerado alerta.
    expect(res.status).not.toBe("error");
    expect(env.db.alerts.length).toBeGreaterThan(0);
    // Cada alerta persistido tem o seu registro na trilha.
    expect(env.db.auditRecords.filter((a) => a.action === "alert.created")).toHaveLength(
      env.db.alerts.length
    );
  });
});
