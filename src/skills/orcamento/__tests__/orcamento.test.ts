import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type {
  Category,
  CostCenter,
  Payable,
  Payment,
  Receipt,
  Receivable,
} from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  orcamentoSkill,
  type CheckImpactData,
  type ForecastData,
  type UpsertBudgetData,
  type VarianceReportData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 (São Paulo).

let seq = 0;

function seedCategory(env: TestEnv, over: Partial<Category> = {}): Category {
  const category: Category = {
    id: `cat_${++seq}`,
    companyId: env.company.id,
    name: `Categoria ${seq}`,
    kind: "expense",
    dreGroup: "despesas_operacionais",
    active: true,
    ...over,
  };
  env.db.categories.push(category);
  return category;
}

function seedCostCenter(env: TestEnv, over: Partial<CostCenter> = {}): CostCenter {
  const costCenter: CostCenter = {
    id: `cc_${++seq}`,
    companyId: env.company.id,
    code: `CC-${seq}`,
    name: `Centro ${seq}`,
    active: true,
    ...over,
  };
  env.db.costCenters.push(costCenter);
  return costCenter;
}

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Título de teste",
    issueDate: "2026-07-01",
    dueDate: "2026-07-10",
    amountCents: 50_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `origin_${id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(payable);
  return payable;
}

/** Pagamento executado — fonte primária do realizado de despesas. */
function seedExecutedPayment(
  env: TestEnv,
  payableId: string,
  amountCents: number,
  executedAt: string
): Payment {
  const now = env.clock.now().toISOString();
  const payment: Payment = {
    id: `pay_${++seq}`,
    companyId: env.company.id,
    payableId,
    bankAccountId: "ba_1",
    amountCents,
    scheduledDate: executedAt.slice(0, 10),
    executedAt,
    status: "executed",
    method: "pix",
    requestedBy: "usr_analyst",
    executedBy: "usr_approver",
    createdAt: now,
    updatedAt: now,
  };
  env.db.payments.push(payment);
  return payment;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> = {}): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `rcv_${++seq}`;
  const receivable: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Recebível de teste",
    issueDate: "2026-07-01",
    dueDate: "2026-07-20",
    amountCents: 100_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `origin_${id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.receivables.push(receivable);
  return receivable;
}

/** Receipt — fonte primária do realizado de receitas. */
function seedReceipt(
  env: TestEnv,
  receivableId: string,
  amountCents: number,
  receivedDate: string
): Receipt {
  const receipt: Receipt = {
    id: `rcp_${++seq}`,
    companyId: env.company.id,
    receivableId,
    amountCents,
    receivedDate,
    method: "pix",
    registeredBy: "usr_analyst",
    createdAt: env.clock.now().toISOString(),
  };
  env.db.receipts.push(receipt);
  return receipt;
}

async function run(env: TestEnv, input: unknown) {
  return runSkill(orcamentoSkill, env.ctx(), input);
}

// ---------------------------------------------------------------------------
// upsert_budget
// ---------------------------------------------------------------------------

describe("orcamento_planejamento — upsert_budget", () => {
  it("cria orçamento com linhas e é idempotente por (name, year)", async () => {
    const env = createTestEnv();
    const catMkt = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
    const cc = seedCostCenter(env, { id: "cc_com", name: "Comercial" });

    const input = {
      action: "upsert_budget",
      name: "Orçamento 2026",
      year: 2026,
      lines: [
        { period: "2026-07", categoryId: catMkt.id, amountCents: 50_000 },
        { period: "2026-08", categoryId: catMkt.id, costCenterId: cc.id, amountCents: 70_000 },
      ],
    };

    const first = await run(env, input);
    expect(first.status).toBe("success");
    const firstData = first.data as UpsertBudgetData;
    expect(firstData.budget.name).toBe("Orçamento 2026");
    expect(firstData.budget.year).toBe(2026);
    expect(firstData.budget.status).toBe("active");
    expect(firstData.lines).toHaveLength(2);
    expect(env.db.budgets).toHaveLength(1);
    expect(env.db.budgetLines).toHaveLength(2);

    // Repetição idêntica: mesmo orçamento, mesmas linhas, sem duplicar nada.
    const second = await run(env, input);
    const secondData = second.data as UpsertBudgetData;
    expect(secondData.budget.id).toBe(firstData.budget.id);
    expect(env.db.budgets).toHaveLength(1);
    expect(env.db.budgetLines).toHaveLength(2);
    expect(secondData.lines.map((l) => l.id).sort()).toEqual(
      firstData.lines.map((l) => l.id).sort()
    );
    expect(second.assumptions.join(" ")).toMatch(/já existia/);
  });

  it("substitui linhas: atualiza valor por chave e zera linhas órfãs", async () => {
    const env = createTestEnv();
    const catMkt = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
    const catAlu = seedCategory(env, { id: "cat_alu", name: "Aluguel" });

    await run(env, {
      action: "upsert_budget",
      name: "Orçamento 2026",
      year: 2026,
      lines: [
        { period: "2026-07", categoryId: catMkt.id, amountCents: 50_000 },
        { period: "2026-07", categoryId: catAlu.id, amountCents: 30_000 },
      ],
    });

    // Nova versão: marketing muda de valor; aluguel sai (deve ser zerado).
    const res = await run(env, {
      action: "upsert_budget",
      name: "Orçamento 2026",
      year: 2026,
      lines: [{ period: "2026-07", categoryId: catMkt.id, amountCents: 80_000 }],
    });

    const data = res.data as UpsertBudgetData;
    expect(env.db.budgets).toHaveLength(1);
    expect(env.db.budgetLines).toHaveLength(2); // nenhuma criada nem removida
    const mkt = data.lines.find((l) => l.categoryId === catMkt.id);
    const alu = data.lines.find((l) => l.categoryId === catAlu.id);
    expect(mkt?.amountCents).toBe(80_000);
    expect(alu?.amountCents).toBe(0);
    expect(res.assumptions.join(" ")).toMatch(/órfã/);
  });

  it("valida formato do período, ano da linha, duplicidade e existência de categoria/centro", async () => {
    const env = createTestEnv();
    const cat = seedCategory(env, { id: "cat_mkt", name: "Marketing" });

    const badPeriod = await run(env, {
      action: "upsert_budget",
      name: "B",
      year: 2026,
      lines: [{ period: "2026-13", categoryId: cat.id, amountCents: 100 }],
    });
    expect(badPeriod.status).toBe("error");
    expect(badPeriod.alerts[0].code).toBe("invalid_input");

    const wrongYear = await run(env, {
      action: "upsert_budget",
      name: "B",
      year: 2026,
      lines: [{ period: "2025-07", categoryId: cat.id, amountCents: 100 }],
    });
    expect(wrongYear.status).toBe("error");
    expect(wrongYear.alerts[0].code).toBe("validation_error");

    const dupLine = await run(env, {
      action: "upsert_budget",
      name: "B",
      year: 2026,
      lines: [
        { period: "2026-07", categoryId: cat.id, amountCents: 100 },
        { period: "2026-07", categoryId: cat.id, amountCents: 200 },
      ],
    });
    expect(dupLine.status).toBe("error");
    expect(dupLine.alerts[0].code).toBe("validation_error");

    const missingCat = await run(env, {
      action: "upsert_budget",
      name: "B",
      year: 2026,
      lines: [{ period: "2026-07", categoryId: "cat_inexistente", amountCents: 100 }],
    });
    expect(missingCat.status).toBe("error");
    expect(missingCat.alerts[0].code).toBe("not_found");

    expect(env.db.budgets).toHaveLength(0);
    expect(env.db.budgetLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// variance_report
// ---------------------------------------------------------------------------

/**
 * Cenário de julho/2026:
 * - orçado: Marketing R$ 500,00; Serviços (receita) R$ 1.000,00; Frota R$ 0,00.
 * - realizado: Marketing R$ 600,00 (payment executado); Serviços R$ 1.000,00
 *   (receipt); Frota R$ 50,00; Aluguel R$ 200,00 SEM linha orçada.
 */
async function seedVarianceScenario(env: TestEnv) {
  const catMkt = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
  const catServ = seedCategory(env, {
    id: "cat_serv",
    name: "Serviços",
    kind: "income",
    dreGroup: "receita_bruta",
  });
  const catFrota = seedCategory(env, { id: "cat_frota", name: "Frota" });
  const catAlu = seedCategory(env, { id: "cat_alu", name: "Aluguel" });

  const upsert = await run(env, {
    action: "upsert_budget",
    name: "Orçamento 2026",
    year: 2026,
    lines: [
      { period: "2026-07", categoryId: catMkt.id, amountCents: 50_000 },
      { period: "2026-07", categoryId: catServ.id, amountCents: 100_000 },
      { period: "2026-07", categoryId: catFrota.id, amountCents: 0 },
    ],
  });
  const budgetLines = (upsert.data as UpsertBudgetData).lines;

  const pMkt = seedPayable(env, { categoryId: catMkt.id, dueDate: "2026-07-10" });
  seedExecutedPayment(env, pMkt.id, 60_000, "2026-07-15T12:00:00Z");
  const pFrota = seedPayable(env, { categoryId: catFrota.id, dueDate: "2026-07-12" });
  seedExecutedPayment(env, pFrota.id, 5_000, "2026-07-16T12:00:00Z");
  const pAlu = seedPayable(env, { categoryId: catAlu.id, dueDate: "2026-07-05" });
  seedExecutedPayment(env, pAlu.id, 20_000, "2026-07-05T12:00:00Z");

  const rcv = seedReceivable(env, { categoryId: catServ.id });
  seedReceipt(env, rcv.id, 100_000, "2026-07-20");

  return { catMkt, catServ, catFrota, catAlu, budgetLines };
}

describe("orcamento_planejamento — variance_report", () => {
  it("calcula variâncias exatas, gera alerta e evento de desvio relevante", async () => {
    const env = createTestEnv();
    const { catMkt, catServ, catFrota, catAlu } = await seedVarianceScenario(env);

    const res = await run(env, { action: "variance_report", period: "2026-07" });
    expect(res.status).toBe("warning");
    expect(res.confidence).toBe(1.0);
    const data = res.data as VarianceReportData;
    expect(data.period).toBe("2026-07");
    expect(data.formula).toMatch(/variância = realizado - orçado/);

    const mkt = data.lines.find((l) => l.categoryId === catMkt.id)!;
    // variância = 60.000 - 50.000 = 10.000; % = 10.000/50.000×100 = 20%
    expect(mkt.budgetedCents).toBe(50_000);
    expect(mkt.actualCents).toBe(60_000);
    expect(mkt.varianceCents).toBe(10_000);
    expect(mkt.variancePercent).toBe(20);
    expect(mkt.categoryName).toBe("Marketing");

    const serv = data.lines.find((l) => l.categoryId === catServ.id)!;
    expect(serv.budgetedCents).toBe(100_000);
    expect(serv.actualCents).toBe(100_000);
    expect(serv.varianceCents).toBe(0);
    expect(serv.variancePercent).toBe(0);

    // Orçado zero → percentual null com suposição explícita.
    const frota = data.lines.find((l) => l.categoryId === catFrota.id)!;
    expect(frota.budgetedCents).toBe(0);
    expect(frota.actualCents).toBe(5_000);
    expect(frota.variancePercent).toBeNull();
    expect(res.assumptions.join(" ")).toMatch(/orçado zero/);

    expect(data.totals).toEqual({
      budgetedCents: 150_000,
      actualCents: 165_000,
      varianceCents: 15_000,
    });

    // Desvio relevante só no Marketing (20% > 10% e R$ 100,00 >= R$ 100,00).
    const deviationAlerts = res.alerts.filter((a) => a.code === "budget_deviation");
    expect(deviationAlerts).toHaveLength(1);
    expect(deviationAlerts[0].entityId).toBe(mkt.budgetLineId);

    const persisted = (await env.repos.alerts.listOpen(env.company.id)).filter(
      (a) => a.code === "budget_deviation"
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].source).toBe("orcamento_planejamento");

    const events = await env.repos.events.list(env.company.id, "budget.deviation_detected");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      period: "2026-07",
      budgetLineId: mkt.budgetLineId,
      budgetedCents: 50_000,
      actualCents: 60_000,
      varianceCents: 10_000,
      variancePercent: 20,
    });

    // Categoria com realizado e sem linha orçada vira pendência "não orçado".
    const naoOrcado = res.pending_items.filter((p) => p.code === "nao_orcado");
    expect(naoOrcado).toHaveLength(1);
    expect(naoOrcado[0].entityId).toBe(catAlu.id);
    expect(naoOrcado[0].description).toMatch(/R\$\s?200,00/);
  });

  it("não duplica o alerta persistido em reexecução (dedupe por code+entityId)", async () => {
    const env = createTestEnv();
    await seedVarianceScenario(env);

    await run(env, { action: "variance_report", period: "2026-07" });
    await run(env, { action: "variance_report", period: "2026-07" });

    const persisted = (await env.repos.alerts.listOpen(env.company.id)).filter(
      (a) => a.code === "budget_deviation"
    );
    expect(persisted).toHaveLength(1);
  });

  it("sem orçamento para o ano → warning com pendência sem_orcamento", async () => {
    const env = createTestEnv();
    const res = await run(env, { action: "variance_report", period: "2026-07" });
    expect(res.status).toBe("warning");
    const data = res.data as VarianceReportData;
    expect(data.lines).toEqual([]);
    expect(data.totals).toEqual({ budgetedCents: 0, actualCents: 0, varianceCents: 0 });
    expect(res.pending_items.map((p) => p.code)).toContain("sem_orcamento");
  });
});

// ---------------------------------------------------------------------------
// check_impact
// ---------------------------------------------------------------------------

describe("orcamento_planejamento — check_impact", () => {
  it("detecta estouro: comprometido inclui o próprio título e os demais abertos do mês", async () => {
    const env = createTestEnv();
    const catMkt = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
    await run(env, {
      action: "upsert_budget",
      name: "Orçamento 2026",
      year: 2026,
      lines: [{ period: "2026-09", categoryId: catMkt.id, amountCents: 100_000 }],
    });
    seedPayable(env, {
      id: "payb_x",
      categoryId: catMkt.id,
      dueDate: "2026-09-10",
      amountCents: 80_000,
    });
    const target = seedPayable(env, {
      id: "payb_y",
      categoryId: catMkt.id,
      dueDate: "2026-09-20",
      amountCents: 50_000,
    });

    const res = await run(env, { action: "check_impact", payableIds: [target.id] });
    expect(res.status).toBe("warning");
    const data = res.data as CheckImpactData;
    expect(data.impacts).toHaveLength(1);
    // comprometido = 80.000 + 50.000 (o próprio) + 0 executado = 130.000
    expect(data.impacts[0]).toEqual({
      payableId: "payb_y",
      period: "2026-09",
      categoryId: catMkt.id,
      budgetedCents: 100_000,
      committedCents: 130_000,
      remainingCents: -30_000,
      exceeded: true,
    });
    expect(res.alerts.some((a) => a.code === "budget_impact_exceeded")).toBe(true);
    const persisted = (await env.repos.alerts.listOpen(env.company.id)).filter(
      (a) => a.code === "budget_impact_exceeded"
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].entityId).toBe("payb_y");
  });

  it("dentro do orçamento não gera alerta e considera realizado do mês", async () => {
    const env = createTestEnv();
    const catMkt = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
    await run(env, {
      action: "upsert_budget",
      name: "Orçamento 2026",
      year: 2026,
      lines: [{ period: "2026-09", categoryId: catMkt.id, amountCents: 100_000 }],
    });
    // Já pago no mês: R$ 300,00 executados entram no comprometido.
    const paid = seedPayable(env, {
      categoryId: catMkt.id,
      dueDate: "2026-09-01",
      amountCents: 30_000,
      paidCents: 30_000,
      status: "paid",
    });
    seedExecutedPayment(env, paid.id, 30_000, "2026-09-01T12:00:00Z");
    const target = seedPayable(env, {
      id: "payb_ok",
      categoryId: catMkt.id,
      dueDate: "2026-09-15",
      amountCents: 40_000,
    });

    const res = await run(env, { action: "check_impact", payableIds: [target.id] });
    expect(res.status).toBe("success");
    const impact = (res.data as CheckImpactData).impacts[0];
    // comprometido = 40.000 (aberto) + 30.000 (executado) = 70.000; restante 30.000
    expect(impact.committedCents).toBe(70_000);
    expect(impact.remainingCents).toBe(30_000);
    expect(impact.exceeded).toBe(false);
    expect(res.alerts).toHaveLength(0);
  });

  it("sem linha orçada → assumption e impacto não avaliado (sem alerta)", async () => {
    const env = createTestEnv();
    const catAlu = seedCategory(env, { id: "cat_alu", name: "Aluguel" });
    const target = seedPayable(env, {
      categoryId: catAlu.id,
      dueDate: "2026-09-05",
      amountCents: 25_000,
    });

    const res = await run(env, { action: "check_impact", payableIds: [target.id] });
    expect(res.status).toBe("success");
    const impact = (res.data as CheckImpactData).impacts[0];
    expect(impact.budgetedCents).toBe(0);
    expect(impact.committedCents).toBe(25_000);
    expect(impact.exceeded).toBe(false);
    expect(res.assumptions.join(" ")).toMatch(/sem orçamento no período/);
    expect(res.alerts).toHaveLength(0);
  });

  it("título inexistente → erro not_found", async () => {
    const env = createTestEnv();
    const res = await run(env, { action: "check_impact", payableIds: ["payb_fantasma"] });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// forecast
// ---------------------------------------------------------------------------

describe("orcamento_planejamento — forecast", () => {
  it("projeta a média móvel dos 3 meses fechados anteriores, por categoria", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18 → histórico 2026-05..2026-07
    const catMkt = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
    const catServ = seedCategory(env, {
      id: "cat_serv",
      name: "Serviços",
      kind: "income",
      dreGroup: "receita_bruta",
    });

    const pMkt = seedPayable(env, { categoryId: catMkt.id });
    seedExecutedPayment(env, pMkt.id, 30_000, "2026-05-10T12:00:00Z");
    seedExecutedPayment(env, pMkt.id, 60_000, "2026-06-10T12:00:00Z");
    seedExecutedPayment(env, pMkt.id, 90_000, "2026-07-10T12:00:00Z");
    // Mês corrente (agosto) NÃO entra no histórico.
    seedExecutedPayment(env, pMkt.id, 999_999, "2026-08-10T12:00:00Z");

    const rcv = seedReceivable(env, { categoryId: catServ.id });
    seedReceipt(env, rcv.id, 100_000, "2026-07-20");

    const res = await run(env, { action: "forecast" });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(0.5);
    expect(res.assumptions.join(" ")).toMatch(/[Ss]azonalidade/);

    const data = res.data as ForecastData;
    expect(data.months).toBe(3);
    expect(data.historyMonths).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(data.formula).toMatch(/média mensal/);

    const mkt = data.byCategory.find((c) => c.categoryId === catMkt.id)!;
    // (30.000 + 60.000 + 90.000) / 3 = 60.000
    expect(mkt.monthlyAvgCents).toBe(60_000);
    expect(mkt.projected).toEqual([
      { period: "2026-09", amountCents: 60_000 },
      { period: "2026-10", amountCents: 60_000 },
      { period: "2026-11", amountCents: 60_000 },
    ]);

    const serv = data.byCategory.find((c) => c.categoryId === catServ.id)!;
    // 100.000 / 3 = 33.333,33... → 33.333 (half-up em centavos)
    expect(serv.monthlyAvgCents).toBe(33_333);
    expect(serv.projected.map((p) => p.period)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("respeita months customizado e retorna vazio sem histórico", async () => {
    const env = createTestEnv();
    const cat = seedCategory(env, { id: "cat_mkt", name: "Marketing" });
    const p = seedPayable(env, { categoryId: cat.id });
    seedExecutedPayment(env, p.id, 12_000, "2026-07-01T12:00:00Z");

    const res = await run(env, { action: "forecast", months: 2 });
    const data = res.data as ForecastData;
    expect(data.months).toBe(2);
    const mkt = data.byCategory[0];
    expect(mkt.monthlyAvgCents).toBe(4_000); // 12.000 / 3
    expect(mkt.projected.map((p2) => p2.period)).toEqual(["2026-09", "2026-10"]);

    const empty = createTestEnv();
    const emptyRes = await run(empty, { action: "forecast" });
    expect((emptyRes.data as ForecastData).byCategory).toEqual([]);
    expect(emptyRes.assumptions.join(" ")).toMatch(/projeção vazia/);
  });
});
