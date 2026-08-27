import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { hasPermission } from "@/core/auth";
import type { Budget, BudgetLine, CostCenter, Payable, Receivable } from "@/core/entities";
import {
  countCostCenterLinks,
  setCostCenterActive,
  updateCostCenterFields,
  countLinkedAgainstScope,
} from "../_lib/update";

function seedCostCenter(
  env: ReturnType<typeof createTestEnv>,
  over: Partial<CostCenter> = {}
): CostCenter {
  const cc: CostCenter = {
    id: "cc_1",
    companyId: env.company.id,
    code: "ADM",
    name: "Administrativo",
    active: true,
    scope: "both",
    ...over,
  };
  env.db.costCenters.push(cc);
  return cc;
}

describe("updateCostCenterFields", () => {
  it("atualiza código e nome e devolve before/after", async () => {
    const env = createTestEnv();
    seedCostCenter(env);

    const { before, after } = await updateCostCenterFields(env, env.company.id, "cc_1", {
      code: "ADM2",
      name: "Administrativo e Financeiro",
    });

    expect(before.code).toBe("ADM");
    expect(before.name).toBe("Administrativo");
    expect(after.code).toBe("ADM2");
    expect(after.name).toBe("Administrativo e Financeiro");
    const stored = await env.repos.costCenters.getById(env.company.id, "cc_1");
    expect(stored?.code).toBe("ADM2");
  });

  it("rejeita código duplicado de OUTRO centro (case-insensitive)", async () => {
    const env = createTestEnv();
    seedCostCenter(env, { id: "cc_1", code: "ADM" });
    seedCostCenter(env, { id: "cc_2", code: "COM", name: "Comercial" });

    await expect(
      updateCostCenterFields(env, env.company.id, "cc_2", { code: "adm", name: "Qualquer" })
    ).rejects.toThrow(/já existe um centro de custo/i);

    // Manter o próprio código (mesmo id) é permitido.
    const ok = await updateCostCenterFields(env, env.company.id, "cc_1", {
      code: "ADM",
      name: "Administrativo Renomeado",
    });
    expect(ok.after.name).toBe("Administrativo Renomeado");
  });

  it("rejeita código ou nome vazios", async () => {
    const env = createTestEnv();
    seedCostCenter(env);
    await expect(
      updateCostCenterFields(env, env.company.id, "cc_1", { code: "", name: "X" })
    ).rejects.toThrow(/informe código e nome/i);
  });
});

describe("setCostCenterActive (desativar/reativar)", () => {
  it("desativa um centro ativo (before/after) e é idempotente", async () => {
    const env = createTestEnv();
    seedCostCenter(env, { active: true });

    const off = await setCostCenterActive(env, env.company.id, "cc_1", false);
    expect(off.unchanged).toBe(false);
    expect(off.before.active).toBe(true);
    expect(off.after.active).toBe(false);

    // Já inativo: idempotente, não gera mudança.
    const again = await setCostCenterActive(env, env.company.id, "cc_1", false);
    expect(again.unchanged).toBe(true);

    // Reativar.
    const on = await setCostCenterActive(env, env.company.id, "cc_1", true);
    expect(on.unchanged).toBe(false);
    expect(on.after.active).toBe(true);
  });
});

describe("countCostCenterLinks", () => {
  it("conta vínculos em títulos a pagar, a receber e linhas de orçamento", async () => {
    const env = createTestEnv();
    seedCostCenter(env, { id: "cc_1" });
    seedCostCenter(env, { id: "cc_2", code: "COM" });
    const now = env.clock.now().toISOString();

    const payable = (over: Partial<Payable>): Payable => ({
      id: over.id!,
      companyId: env.company.id,
      supplierId: "sup_1",
      description: "t",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      amountCents: 1000,
      paidCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: over.id!,
      createdBy: "u",
      createdAt: now,
      updatedAt: now,
      ...over,
    });
    env.db.payables.push(payable({ id: "p1", costCenterId: "cc_1" }));
    env.db.payables.push(payable({ id: "p2", costCenterId: "cc_1" }));
    env.db.payables.push(payable({ id: "p3", costCenterId: "cc_2" }));

    const receivable: Receivable = {
      id: "r1",
      companyId: env.company.id,
      customerId: "cus_1",
      description: "r",
      issueDate: "2026-01-01",
      dueDate: "2026-02-01",
      amountCents: 500,
      receivedCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "r1",
      costCenterId: "cc_1",
      createdBy: "u",
      createdAt: now,
      updatedAt: now,
    };
    env.db.receivables.push(receivable);

    const budget: Budget = {
      id: "b1",
      companyId: env.company.id,
      name: "2026",
      year: 2026,
      status: "active",
      createdAt: now,
    };
    env.db.budgets.push(budget);
    const line: BudgetLine = {
      id: "bl1",
      budgetId: "b1",
      period: "2026-01",
      categoryId: "cat_1",
      costCenterId: "cc_1",
      amountCents: 1000,
    };
    env.db.budgetLines.push(line);

    // cc_1: 2 payables + 1 receivable + 1 budget line = 4.
    expect(await countCostCenterLinks(env, env.company.id, "cc_1")).toBe(4);
    // cc_2: só 1 payable.
    expect(await countCostCenterLinks(env, env.company.id, "cc_2")).toBe(1);
  });
});

describe("permissão do cadastro de centros de custo", () => {
  it("viewer NÃO tem master_data.manage; finance_analyst tem", () => {
    // A action exige master_data.manage; garante a regra usada para ocultar botões.
    expect(hasPermission("viewer", "master_data.manage")).toBe(false);
    expect(hasPermission("finance_analyst", "master_data.manage")).toBe(true);
  });
});

describe("destino do centro de custo (scope)", () => {
  it("mantém o destino atual quando o campo não é enviado", async () => {
    const env = createTestEnv();
    seedCostCenter(env, { scope: "receivable" });
    const { after } = await updateCostCenterFields(env, env.company.id, "cc_1", {
      code: "ADM",
      name: "Administrativo",
    });
    expect(after.scope).toBe("receivable");
  });

  it("altera o destino quando enviado", async () => {
    const env = createTestEnv();
    seedCostCenter(env, { scope: "both" });
    const { before, after } = await updateCostCenterFields(env, env.company.id, "cc_1", {
      code: "ADM",
      name: "Administrativo",
      scope: "payable",
    });
    expect(before.scope).toBe("both");
    expect(after.scope).toBe("payable");
  });

  it("conta os lançamentos do lado oposto sem desvinculá-los", async () => {
    const env = createTestEnv();
    seedCostCenter(env, { scope: "both" });
    env.db.receivables.push({
      id: "rec_1",
      companyId: env.company.id,
      customerId: "cus_1",
      description: "Venda",
      issueDate: "2026-06-01",
      dueDate: "2026-07-01",
      amountCents: 1000,
      receivedCents: 0,
      currency: "BRL",
      status: "open",
      costCenterId: "cc_1",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "k1",
      createdBy: "usr",
      createdAt: "",
      updatedAt: "",
    });

    const n = await countLinkedAgainstScope(env, env.company.id, "cc_1", "payable");
    expect(n).toBe(1);
    // O título continua vinculado: o destino filtra só lançamentos novos.
    expect(env.db.receivables[0].costCenterId).toBe("cc_1");
  });

  it('destino "both" não gera aviso', async () => {
    const env = createTestEnv();
    seedCostCenter(env);
    expect(await countLinkedAgainstScope(env, env.company.id, "cc_1", "both")).toBe(0);
  });
});
