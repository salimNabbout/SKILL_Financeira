/**
 * Painel por Período (Dashboard) — ação `period_panel` da skill de relatórios
 * sobre o adaptador em memória (PNL-01..PNL-09 do relatório de fórmulas).
 *
 * Cobre: regime de caixa (data de execução, não vencimento), fuso às 22h30,
 * cancelado, pagamento parcial, recibo estornado, não classificado, sem
 * centro, cascata centro → categoria, identidades, anos disponíveis, aviso de
 * baixa sem Payment, dias ajustados, base vazia e validações.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { CostCenter, Payable, Payment, Receipt } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { relatoriosSkill, type PeriodPanelData } from "../index";

let seq = 0;

function seedCostCenter(env: TestEnv, over: Partial<CostCenter> & { id: string; code: string; name: string }): CostCenter {
  const cc: CostCenter = { companyId: env.company.id, active: true, scope: "both", ...over };
  env.db.costCenters.push(cc);
  return cc;
}

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const p: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: id,
    issueDate: "2026-07-01",
    dueDate: "2026-09-30", // vencimento fora do período: não pode importar
    amountCents: 10_000,
    paidCents: 10_000,
    currency: "BRL",
    status: "paid",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(p);
  return p;
}

function seedPayment(env: TestEnv, payableId: string, amountCents: number, executedAt: string, status: Payment["status"] = "executed"): Payment {
  const now = env.clock.now().toISOString();
  const y: Payment = {
    id: `pay_${++seq}`,
    companyId: env.company.id,
    payableId,
    bankAccountId: "acc_1",
    amountCents,
    scheduledDate: executedAt.slice(0, 10),
    executedAt: status === "executed" ? executedAt : undefined,
    status,
    requestedBy: "usr",
    createdAt: now,
    updatedAt: now,
  };
  env.db.payments.push(y);
  return y;
}

function seedReceipt(env: TestEnv, amountCents: number, receivedDate: string, status?: "registered" | "canceled"): Receipt {
  const r: Receipt = {
    id: `rcp_${++seq}`,
    companyId: env.company.id,
    receivableId: "rcv_1",
    bankAccountId: "acc_1",
    amountCents,
    receivedDate,
    method: "pix",
    status,
    registeredBy: "usr",
    createdAt: env.clock.now().toISOString(),
  };
  env.db.receipts.push(r);
  return r;
}

async function panel(env: TestEnv, input: Record<string, unknown>) {
  const res = await runSkill(relatoriosSkill, env.ctx(), { action: "period_panel", ...input });
  return { res, data: res.data as PeriodPanelData };
}

/** Agosto/2026 com todos os casos de borda. */
function seedScenario(env: TestEnv) {
  const adm = seedCostCenter(env, { id: "cc_adm", code: "100", name: "Administrativo" });
  seedCostCenter(env, { id: "cc_com", code: "200", name: "Comercial" });
  seedCostCenter(env, { id: "cc_off", code: "300", name: "Inativo", active: false });
  seedCostCenter(env, { id: "cc_rec", code: "400", name: "Só receber", scope: "receivable" });

  // Fixo no centro adm, categoria Aluguel — pago em 05/08 (vencimento 30/09: caixa, não competência de vencimento)
  const p1 = seedPayable(env, { costClassification: "fixed", costCenterId: adm.id, supplierCategory: "Aluguel", amountCents: 5_000, paidCents: 5_000 });
  seedPayment(env, p1.id, 5_000, "2026-08-05T15:00:00.000Z");
  // Variável no centro adm, categoria Frete — pago às 22h30 de 31/08 em SP (01h30 UTC de 01/09): AGOSTO
  const p2 = seedPayable(env, { costClassification: "variable", costCenterId: adm.id, supplierCategory: "Frete", amountCents: 1_000, paidCents: 1_000 });
  seedPayment(env, p2.id, 1_000, "2026-09-01T01:30:00.000Z");
  // Fixo no centro comercial, categoria Aluguel
  const p3 = seedPayable(env, { costClassification: "fixed", costCenterId: "cc_com", supplierCategory: "Aluguel", amountCents: 3_000, paidCents: 3_000 });
  seedPayment(env, p3.id, 3_000, "2026-08-20T15:00:00.000Z");
  // Sem classificação, centro comercial, categoria Frete — pagamento PARCIAL (700 de 2.000)
  const p4 = seedPayable(env, { costCenterId: "cc_com", supplierCategory: "Frete", amountCents: 2_000, paidCents: 700, status: "partially_paid" });
  seedPayment(env, p4.id, 700, "2026-08-21T15:00:00.000Z");
  // Variável sem centro e sem categoria
  const p5 = seedPayable(env, { costClassification: "variable", amountCents: 300, paidCents: 300 });
  seedPayment(env, p5.id, 300, "2026-08-22T15:00:00.000Z");
  // CANCELADO com pagamento executado (não deve entrar)
  const p6 = seedPayable(env, { costClassification: "fixed", costCenterId: adm.id, supplierCategory: "Aluguel", amountCents: 99_999, status: "canceled", canceledAt: "2026-08-25T12:00:00.000Z" });
  seedPayment(env, p6.id, 99_999, "2026-08-23T15:00:00.000Z");
  // Pagamento aprovado mas NÃO executado (não entra)
  const p7 = seedPayable(env, { costClassification: "fixed", costCenterId: adm.id, supplierCategory: "Aluguel", amountCents: 50_000, paidCents: 0, status: "scheduled" });
  seedPayment(env, p7.id, 50_000, "2026-08-24T15:00:00.000Z", "approved");
  // Julho (fora) e setembro (fora)
  const p8 = seedPayable(env, { costClassification: "fixed", costCenterId: adm.id, supplierCategory: "Aluguel", amountCents: 777, paidCents: 777 });
  seedPayment(env, p8.id, 777, "2026-07-31T15:00:00.000Z");
  const p9 = seedPayable(env, { costClassification: "fixed", costCenterId: adm.id, supplierCategory: "Aluguel", amountCents: 888, paidCents: 888 });
  seedPayment(env, p9.id, 888, "2026-09-01T15:00:00.000Z");
  // Baixado pela conciliação SEM Payment (paidCents > Σ executados) — fora, com aviso
  seedPayable(env, { costClassification: "fixed", amountCents: 4_444, paidCents: 4_444 });

  // Recebimentos: 2 em agosto (um com encargos), 1 estornado, 1 de 01/09 (fora)
  seedReceipt(env, 20_000, "2026-08-01");
  seedReceipt(env, 10_250, "2026-08-31"); // principal 10.000 + encargos 250: conta o que entrou
  seedReceipt(env, 99_999, "2026-08-15", "canceled");
  seedReceipt(env, 5_000, "2026-09-01");
}

describe("period_panel — totais do período (regime de caixa)", () => {
  it("agosto/2026: recebido, pago, fixo, variável, não classificado e identidade", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    seedScenario(env);
    const { res, data } = await panel(env, { year: 2026, month: 8 });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    expect(data.regime).toBe("caixa");
    expect(data.period).toMatchObject({ from: "2026-08-01", to: "2026-08-31", dayFrom: 1, dayTo: 31, label: "01/08/2026 a 31/08/2026" });

    expect(data.totals.receivedCents).toBe(30_250);
    expect(data.totals.receivedCount).toBe(2);
    // 5.000 + 1.000 (22h30 de 31/08) + 3.000 + 700 (parcial) + 300 = 10.000
    expect(data.totals.paidCents).toBe(10_000);
    expect(data.totals.paidCount).toBe(5);
    expect(data.totals.fixedCents).toBe(8_000);
    expect(data.totals.variableCents).toBe(1_300);
    expect(data.totals.unclassifiedCents).toBe(700);
    expect(data.totals.fixedCents + data.totals.variableCents + data.totals.unclassifiedCents).toBe(data.totals.paidCents);

    expect(res.audit.data_sources).toEqual(["payments", "payables", "receipts", "cost_centers"]);
    expect(res.assumptions.some((a) => a.includes("Regime de CAIXA"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("Transferências entre contas"))).toBe(true);
    expect(data.formulas.paid).toContain("executedAt");
  });

  it("centro de custo e categoria: opções, faixas, cascata e identidades", async () => {
    const env = createTestEnv();
    seedScenario(env);
    const all = (await panel(env, { year: 2026, month: 8 })).data;
    // Opções do select: só ativos com destino pagar/ambos, por código (o inativo e o "só receber" ficam fora).
    expect(all.costCenters.map((c) => `${c.code} — ${c.name}`)).toEqual(["100 — Administrativo", "200 — Comercial"]);
    expect(all.byCostCenter.map((c) => [c.name, c.totalCents])).toEqual([
      ["Administrativo", 6_000],
      ["Comercial", 3_700],
      ["Sem centro", 300],
    ]);
    expect(all.byCostCenter.reduce((s, c) => s + c.totalCents, 0)).toBe(all.totals.paidCents);
    expect(all.selectedCostCenterId).toBeNull();
    expect(all.costCenterTotalCents).toBe(10_000);
    expect(all.categories.map((c) => [c.category, c.totalCents])).toEqual([
      ["Aluguel", 8_000],
      ["Frete", 1_700],
      ["(sem categoria)", 300],
    ]);

    const com = (await panel(env, { year: 2026, month: 8, costCenterId: "cc_com" })).data;
    expect(com.costCenterTotalCents).toBe(3_700);
    expect(com.categories.map((c) => [c.category, c.totalCents, c.percentOfCenter])).toEqual([
      ["Aluguel", 3_000, 81.08],
      ["Frete", 700, 18.92],
    ]);
    expect(com.categories.reduce((s, c) => s + c.totalCents, 0)).toBe(com.costCenterTotalCents);
    // Os 4 totais (e o gráfico) não reagem ao centro.
    expect(com.totals).toEqual(all.totals);

    const cat = (await panel(env, { year: 2026, month: 8, costCenterId: "cc_com", category: "Frete" })).data;
    expect(cat.selectedCategory).toBe("Frete");
    expect(cat.categoryTotalCents).toBe(700);
  });

  it("aviso de títulos baixados sem Payment (ignorados) e anos disponíveis", async () => {
    const env = createTestEnv();
    seedScenario(env);
    const { res, data } = await panel(env, { year: 2026, month: 8 });
    expect(data.settledWithoutPaymentCount).toBe(1);
    expect(res.alerts).toEqual([
      expect.objectContaining({ severity: "info", code: "settled_without_payment_ignored" }),
    ]);
    expect(res.alerts[0].message).toContain("1 título(s)");
    expect(data.availableYears).toEqual([2026]);
  });

  it("sub-período de dias (5 a 12) e dias ajustados ao mês (31 → 30 em setembro) com suposição", async () => {
    const env = createTestEnv();
    seedScenario(env);
    const sub = (await panel(env, { year: 2026, month: 8, dayFrom: 5, dayTo: 12 })).data;
    expect(sub.totals.paidCents).toBe(5_000); // só o de 05/08
    expect(sub.totals.receivedCents).toBe(0);
    const { res, data } = await panel(env, { year: 2026, month: 9, dayFrom: 1, dayTo: 31 });
    expect(data.period.to).toBe("2026-09-30");
    expect(res.assumptions.some((a) => a.includes("Dias ajustados"))).toBe(true);
    expect(data.totals.paidCents).toBe(888);
  });

  it("mês 'Todos' = ano inteiro", async () => {
    const env = createTestEnv();
    seedScenario(env);
    const { data } = await panel(env, { year: 2026 });
    expect(data.period).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(data.totals.paidCents).toBe(10_000 + 777 + 888);
    expect(data.totals.receivedCents).toBe(35_250);
  });

  it("base vazia: zeros, sem centros com movimento, sem aviso, ano corrente disponível", async () => {
    const env = createTestEnv();
    const { res, data } = await panel(env, { year: 2026, month: 8 });
    expect(data.totals).toEqual({ receivedCents: 0, receivedCount: 0, paidCents: 0, paidCount: 0, fixedCents: 0, variableCents: 0, unclassifiedCents: 0 });
    expect(data.byCostCenter).toEqual([]);
    expect(data.categories).toEqual([]);
    expect(data.availableYears).toEqual([2026]);
    expect(res.alerts).toEqual([]);
  });

  it("validações: dia inicial > final, mês inválido e centro inexistente viram erro", async () => {
    const env = createTestEnv();
    seedScenario(env);
    expect((await panel(env, { year: 2026, month: 8, dayFrom: 20, dayTo: 10 })).res.status).toBe("error");
    expect((await panel(env, { year: 2026, month: 13 })).res.status).toBe("error");
    expect((await panel(env, { year: 2026, month: 8, costCenterId: "cc_nao_existe" })).res.status).toBe("error");
  });
});
