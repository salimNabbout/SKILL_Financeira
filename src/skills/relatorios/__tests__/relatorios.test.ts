import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import {
  relatoriosSkill,
  type DailySummaryData,
  type ExecutiveOverviewData,
  type ExportDataData,
  type MonthlyCloseData,
} from "../index";

/**
 * Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → hoje = 2026-08-18
 * em America/Sao_Paulo. Todos os números do cenário principal estão
 * calculados à mão nos comentários de cada teste.
 */

// ---------------------------------------------------------------------------
// Fábricas de entidades (valores obrigatórios preenchidos, overrides pontuais)
// ---------------------------------------------------------------------------

async function seedAccount(
  env: TestEnv,
  id: string,
  openingBalanceCents: number,
  active = true
): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.bankAccounts.create({
    id,
    companyId: env.company.id,
    name: `Conta ${id}`,
    bankCode: "001",
    agency: "0001",
    accountNumberMasked: "***0001",
    type: "checking",
    currency: "BRL",
    openingBalanceCents,
    openingBalanceDate: "2026-06-01",
    active,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedTx(
  env: TestEnv,
  id: string,
  bankAccountId: string,
  date: string,
  amountCents: number
): Promise<void> {
  await env.repos.bankTransactions.create({
    id,
    companyId: env.company.id,
    bankAccountId,
    date,
    amountCents,
    currency: "BRL",
    description: `Movimento ${id}`,
    source: "ofx",
    reconciled: false,
    createdAt: env.clock.now().toISOString(),
  });
}

interface PayableSeed {
  id: string;
  description?: string;
  issueDate: string;
  dueDate: string;
  amountCents: number;
  paidCents?: number;
  status?: "open" | "scheduled" | "partially_paid" | "paid" | "canceled";
  categoryId?: string;
}

async function seedPayable(env: TestEnv, seed: PayableSeed): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.payables.create({
    id: seed.id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: seed.description ?? `Título ${seed.id}`,
    issueDate: seed.issueDate,
    dueDate: seed.dueDate,
    amountCents: seed.amountCents,
    paidCents: seed.paidCents ?? 0,
    currency: "BRL",
    status: seed.status ?? "open",
    categoryId: seed.categoryId,
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `origin-${seed.id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  });
}

interface ReceivableSeed {
  id: string;
  description?: string;
  issueDate: string;
  dueDate: string;
  amountCents: number;
  receivedCents?: number;
  status?: "open" | "partially_received" | "received" | "canceled";
}

async function seedReceivable(env: TestEnv, seed: ReceivableSeed): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.receivables.create({
    id: seed.id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: seed.description ?? `Recebível ${seed.id}`,
    issueDate: seed.issueDate,
    dueDate: seed.dueDate,
    amountCents: seed.amountCents,
    receivedCents: seed.receivedCents ?? 0,
    currency: "BRL",
    status: seed.status ?? "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `origin-${seed.id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPayment(
  env: TestEnv,
  id: string,
  payableId: string,
  amountCents: number,
  scheduledDate: string,
  status: "pending_approval" | "approved" | "executed" = "executed"
): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.payments.create({
    id,
    companyId: env.company.id,
    payableId,
    bankAccountId: "acc_main",
    amountCents,
    scheduledDate,
    executedAt: status === "executed" ? `${scheduledDate}T14:00:00Z` : undefined,
    status,
    method: "pix",
    requestedBy: "usr_analyst",
    executedBy: status === "executed" ? "usr_manager" : undefined,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedReceipt(
  env: TestEnv,
  id: string,
  receivableId: string,
  amountCents: number,
  receivedDate: string
): Promise<void> {
  await env.repos.receipts.create({
    id,
    companyId: env.company.id,
    receivableId,
    bankAccountId: "acc_main",
    amountCents,
    receivedDate,
    method: "pix",
    registeredBy: "usr_analyst",
    createdAt: env.clock.now().toISOString(),
  });
}

async function seedAlert(
  env: TestEnv,
  id: string,
  severity: "info" | "warning" | "critical",
  status: "open" | "resolved" = "open"
): Promise<void> {
  await env.repos.alerts.create({
    id,
    companyId: env.company.id,
    severity,
    code: `seed_${id}`,
    message: `Alerta ${id}`,
    source: "teste",
    status,
    createdAt: env.clock.now().toISOString(),
    resolvedAt: status === "resolved" ? env.clock.now().toISOString() : undefined,
  });
}

async function seedApproval(
  env: TestEnv,
  id: string,
  status: "pending" | "approved" = "pending"
): Promise<void> {
  await env.repos.approvals.create({
    id,
    companyId: env.company.id,
    targetType: "payment",
    targetId: "pmt_pending",
    summary: `Aprovação ${id}`,
    amountCents: 80_000,
    requestedBy: "usr_analyst",
    requiredRole: "approver",
    status,
    decidedBy: status === "approved" ? "usr_approver" : undefined,
    decidedAt: status === "approved" ? env.clock.now().toISOString() : undefined,
    createdAt: env.clock.now().toISOString(),
  });
}

/**
 * Cenário principal:
 *
 * Contas ativas: acc_main (abertura 10.000,00) e acc_reserve (2.000,00);
 * acc_off inativa (abertura 9.999,99 + crédito de 500,00 em agosto — deve
 * ser ignorada em tudo).
 *
 * Transações acc_main: jun +3.000/−1.000; jul +4.000/−1.500; ago +5.000/−2.000.
 * Disponível hoje = 10.000 + (3.000−1.000+4.000−1.500+5.000−2.000) + 2.000
 *                 = 19.500,00 (1_950_000 centavos).
 *
 * Títulos em aberto (hoje 18/08):
 *  - pay_due_today: vence hoje, 1.200 pago 200 → restante 1.000 (vence hoje);
 *  - pay_overdue: venceu 01/08, restante 1.500;
 *  - pay_next7: vence 22/08, 800; pay_far: vence 01/10, 9.990.
 *  Carteira a pagar = 13.290; vencidos = 1.500 (11,3% > 10%).
 *  - rec_due_today: vence hoje, 900; rec_overdue: venceu 05/08, restante 1.500;
 *  - rec_next7: vence 24/08, 600; rec_far: vence 30/11, 5.000.
 *  Carteira a receber = 8.000; vencidos = 1.500 (18,75% > 10%).
 *
 * Projeção 7d (até 25/08) = 19.500 + (900+1.500+600) − (1.000+1.500+800)
 *                         = 19.500 + 3.000 − 3.300 = 19.200,00 (1_920_000).
 *
 * Fechamento de julho: recebimentos 5.000 (rcp_1 4.000 + rcp_2 1.000);
 * pagamentos executados 3.100 (aluguel 1.500 + insumos 1.200 + 400);
 * novos a pagar (emissão em julho, sem cancelados) = 2.500 + 1.000 = 3.500;
 * novos a receber = 5.000; saldo em 31/07 = 10.000 + (3.000−1.000+4.000−1.500)
 * + 2.000 = 16.500,00 (1_650_000).
 *
 * Alertas abertos: 1 crítico, 1 aviso, 1 informativo (+1 resolvido, ignorado).
 * Aprovações: 1 pendente (+1 aprovada, ignorada).
 */
async function seedMainScenario(env: TestEnv): Promise<void> {
  await seedAccount(env, "acc_main", 1_000_000);
  await seedAccount(env, "acc_reserve", 200_000);
  await seedAccount(env, "acc_off", 999_999, false);

  await seedTx(env, "tx_jun_in", "acc_main", "2026-06-05", 300_000);
  await seedTx(env, "tx_jun_out", "acc_main", "2026-06-20", -100_000);
  await seedTx(env, "tx_jul_in", "acc_main", "2026-07-03", 400_000);
  await seedTx(env, "tx_jul_out", "acc_main", "2026-07-15", -150_000);
  await seedTx(env, "tx_aug_in", "acc_main", "2026-08-05", 500_000);
  await seedTx(env, "tx_aug_out", "acc_main", "2026-08-10", -200_000);
  await seedTx(env, "tx_inactive", "acc_off", "2026-08-06", 50_000);

  await env.repos.categories.create({
    id: "cat_rent",
    companyId: env.company.id,
    name: "Aluguel",
    kind: "expense",
    dreGroup: "despesas_operacionais",
    active: true,
  });
  await env.repos.categories.create({
    id: "cat_supply",
    companyId: env.company.id,
    name: "Insumos",
    kind: "expense",
    dreGroup: "custos",
    active: true,
  });

  // Em aberto (afetam o resumo diário)
  await seedPayable(env, {
    id: "pay_due_today",
    issueDate: "2026-08-01",
    dueDate: "2026-08-18",
    amountCents: 120_000,
    paidCents: 20_000,
    status: "partially_paid",
  });
  await seedPayable(env, {
    id: "pay_overdue",
    issueDate: "2026-08-01",
    dueDate: "2026-08-01",
    amountCents: 150_000,
  });
  await seedPayable(env, {
    id: "pay_next7",
    issueDate: "2026-08-10",
    dueDate: "2026-08-22",
    amountCents: 80_000,
  });
  await seedPayable(env, {
    id: "pay_far",
    issueDate: "2026-08-12",
    dueDate: "2026-10-01",
    amountCents: 999_000,
  });

  // Liquidados/cancelados (afetam apenas o fechamento mensal)
  await seedPayable(env, {
    id: "pay_rent",
    description: "Aluguel do escritório",
    issueDate: "2026-06-25",
    dueDate: "2026-07-05",
    amountCents: 150_000,
    paidCents: 150_000,
    status: "paid",
    categoryId: "cat_rent",
  });
  await seedPayable(env, {
    id: "pay_supply",
    description: "Compra de insumos",
    issueDate: "2026-06-28",
    dueDate: "2026-07-15",
    amountCents: 160_000,
    paidCents: 160_000,
    status: "paid",
    categoryId: "cat_supply",
  });
  await seedPayable(env, {
    id: "pay_jul_a",
    issueDate: "2026-07-02",
    dueDate: "2026-07-30",
    amountCents: 250_000,
    paidCents: 250_000,
    status: "paid",
  });
  await seedPayable(env, {
    id: "pay_jul_b",
    issueDate: "2026-07-20",
    dueDate: "2026-08-15",
    amountCents: 100_000,
    paidCents: 100_000,
    status: "paid",
  });
  await seedPayable(env, {
    id: "pay_jul_cancel",
    issueDate: "2026-07-10",
    dueDate: "2026-07-31",
    amountCents: 50_000,
    status: "canceled",
  });

  await seedReceivable(env, {
    id: "rec_due_today",
    issueDate: "2026-08-01",
    dueDate: "2026-08-18",
    amountCents: 90_000,
  });
  await seedReceivable(env, {
    id: "rec_overdue",
    issueDate: "2026-08-01",
    dueDate: "2026-08-05",
    amountCents: 200_000,
    receivedCents: 50_000,
    status: "partially_received",
  });
  await seedReceivable(env, {
    id: "rec_next7",
    issueDate: "2026-08-10",
    dueDate: "2026-08-24",
    amountCents: 60_000,
  });
  await seedReceivable(env, {
    id: "rec_far",
    issueDate: "2026-08-15",
    dueDate: "2026-11-30",
    amountCents: 500_000,
  });
  await seedReceivable(env, {
    id: "rec_jul",
    description: "Venda de julho",
    issueDate: "2026-07-05",
    dueDate: "2026-07-10",
    amountCents: 500_000,
    receivedCents: 500_000,
    status: "received",
  });

  await seedReceipt(env, "rcp_1", "rec_jul", 400_000, "2026-07-10");
  await seedReceipt(env, "rcp_2", "rec_jul", 100_000, "2026-07-20");
  await seedReceipt(env, "rcp_aug", "rec_overdue", 50_000, "2026-08-06");

  await seedPayment(env, "pmt_rent", "pay_rent", 150_000, "2026-07-05");
  await seedPayment(env, "pmt_sup1", "pay_supply", 120_000, "2026-07-15");
  await seedPayment(env, "pmt_sup2", "pay_supply", 40_000, "2026-07-25");
  await seedPayment(env, "pmt_pending", "pay_next7", 80_000, "2026-08-22", "pending_approval");
  await seedPayment(env, "pmt_aug", "pay_jul_b", 100_000, "2026-08-03");

  await seedAlert(env, "alr_c", "critical");
  await seedAlert(env, "alr_w", "warning");
  await seedAlert(env, "alr_i", "info");
  await seedAlert(env, "alr_res", "warning", "resolved");

  await seedApproval(env, "apr_pending", "pending");
  await seedApproval(env, "apr_done", "approved");
}

// ---------------------------------------------------------------------------
// daily_summary
// ---------------------------------------------------------------------------

describe("relatorios_gerenciais — daily_summary", () => {
  it("consolida fatos, projeção 7d, riscos e recomendações com valores exatos", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);

    const res = await runSkill(relatoriosSkill, env.ctx(), { action: "daily_summary" });
    expect(res.status).toBe("warning"); // alertas de vencidos > 10% da carteira
    expect(res.confidence).toBe(1.0);

    const data = res.data as DailySummaryData;
    expect(data.date).toBe("2026-08-18");
    expect(data.facts).toEqual({
      availableCents: 1_950_000,
      payablesDueTodayCents: 100_000,
      payablesDueTodayCount: 1,
      receivablesDueTodayCents: 90_000,
      receivablesDueTodayCount: 1,
      overduePayablesCents: 150_000,
      overdueReceivablesCents: 150_000,
      openAlerts: { critical: 1, warning: 1, info: 1 },
      pendingApprovals: 1,
    });
    expect(data.calculations.projected7dEndingBalanceCents).toBe(1_920_000);
    expect(data.calculations.formula).toContain("projetado_7d");
    expect(data.calculations.period).toEqual({ start: "2026-08-18", end: "2026-08-25" });

    // Riscos: 2 de vencidos acima de 10% + 1 de aprovação pendente (sem saldo negativo)
    expect(data.risks).toHaveLength(3);
    // 150.000/1.329.000 = 11,29% → exibido 11.3; 150.000/800.000 = 18,75% → exibido 18.8
    expect(data.risks.some((r) => r.includes("11.3%"))).toBe(true);
    expect(data.risks.some((r) => r.includes("18.8%"))).toBe(true);
    expect(data.risks.some((r) => r.includes("aprovação"))).toBe(true);
    expect(data.risks.some((r) => r.includes("negativo"))).toBe(false);
    expect(data.recommendations.length).toBeGreaterThan(0);
    expect(data.sources).toContain("bank_accounts");

    // Item pendente por aprovação parada
    expect(res.pending_items).toHaveLength(1);
    expect(res.pending_items[0].entityId).toBe("apr_pending");

    // Evento + auditoria de geração do relatório
    const events = await env.repos.events.list(env.company.id, "report.generated");
    expect(events).toHaveLength(1);
    const audit = await env.repos.audit.list(env.company.id);
    expect(audit.map((a) => a.action)).toContain("report.generated");

    // Sem novo alerta persistido (projeção positiva): continuam só os 3 do seed
    expect(await env.repos.alerts.listOpen(env.company.id)).toHaveLength(3);
  });

  it("com saldo projetado negativo, aponta o risco e persiste alerta sem duplicar (idempotência)", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 100_000);
    await seedPayable(env, {
      id: "pay_big",
      issueDate: "2026-08-01",
      dueDate: "2026-08-19",
      amountCents: 500_000,
    });

    const first = await runSkill(relatoriosSkill, env.ctx(), { action: "daily_summary" });
    const firstData = first.data as DailySummaryData;
    // 100.000 − 500.000 = −400.000
    expect(firstData.calculations.projected7dEndingBalanceCents).toBe(-400_000);
    expect(firstData.risks.some((r) => r.includes("negativo"))).toBe(true);
    expect(first.alerts.some((a) => a.code === "report_cash_risk_7d")).toBe(true);

    const openAfterFirst = await env.repos.alerts.listOpen(env.company.id);
    expect(openAfterFirst.filter((a) => a.code === "report_cash_risk_7d")).toHaveLength(1);

    const second = await runSkill(relatoriosSkill, env.ctx(), { action: "daily_summary" });
    const openAfterSecond = await env.repos.alerts.listOpen(env.company.id);
    expect(openAfterSecond.filter((a) => a.code === "report_cash_risk_7d")).toHaveLength(1);
    expect(second.assumptions.some((a) => a.includes("não foi duplicado"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// monthly_close
// ---------------------------------------------------------------------------

describe("relatorios_gerenciais — monthly_close", () => {
  it("fecha julho com valores exatos, DRE caixa e destaques determinísticos", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);

    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "monthly_close",
      period: "2026-07",
    });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);

    const data = res.data as MonthlyCloseData;
    expect(data.period).toBe("2026-07");
    expect(data.facts).toEqual({
      receiptsCents: 500_000,
      paymentsCents: 310_000,
      newPayablesCents: 350_000, // exclui o cancelado de 50.000
      newReceivablesCents: 500_000,
      endOfMonthAvailableCents: 1_650_000,
    });
    expect(data.calculations.netCashFlowCents).toBe(190_000);
    expect(data.calculations.period).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(data.calculations.dreSimplificada).toMatchObject({
      regime: "caixa",
      receitaCents: 500_000,
      despesasCents: 310_000,
      resultadoCents: 190_000,
    });

    // Destaques: maior pagamento (aluguel 1.500), maior recebimento (4.000),
    // top categorias (Insumos 1.600 > Aluguel 1.500)
    expect(data.highlights.some((h) => h.includes("Aluguel do escritório"))).toBe(true);
    expect(data.highlights.some((h) => h.includes("Venda de julho"))).toBe(true);
    const topCategorias = data.highlights.find((h) => h.startsWith("Top categorias"));
    expect(topCategorias).toBeDefined();
    expect(topCategorias!.indexOf("Insumos")).toBeLessThan(topCategorias!.indexOf("Aluguel"));

    expect(data.risks).toHaveLength(0);
    expect(data.recommendations).toHaveLength(1);
    // Assumption obrigatória: regime caixa ≠ DRE por competência da controladoria
    expect(res.assumptions.some((a) => a.includes("competência"))).toBe(true);

    const events = await env.repos.events.list(env.company.id, "report.generated");
    expect(events).toHaveLength(1);
  });

  it("mês com resultado negativo e caixa abaixo do mínimo gera riscos e recomendações", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_small", 50_000);
    await seedReceivable(env, {
      id: "rec_x",
      issueDate: "2026-07-01",
      dueDate: "2026-07-10",
      amountCents: 100_000,
      receivedCents: 100_000,
      status: "received",
    });
    await seedReceipt(env, "rcp_x", "rec_x", 100_000, "2026-07-10");
    await seedPayable(env, {
      id: "pay_x",
      issueDate: "2026-06-20",
      dueDate: "2026-07-15",
      amountCents: 300_000,
      paidCents: 300_000,
      status: "paid",
    });
    await seedPayment(env, "pmt_x", "pay_x", 300_000, "2026-07-15");

    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "monthly_close",
      period: "2026-07",
    });
    expect(res.status).toBe("warning");

    const data = res.data as MonthlyCloseData;
    expect(data.calculations.dreSimplificada.resultadoCents).toBe(-200_000);
    expect(data.risks).toHaveLength(2); // resultado negativo + caixa abaixo do mínimo
    expect(data.risks.some((r) => r.includes("negativo"))).toBe(true);
    expect(data.risks.some((r) => r.includes("caixa mínimo"))).toBe(true);
    expect(data.recommendations.some((r) => r.includes("categoria"))).toBe(true);
    expect(res.alerts.map((a) => a.code)).toEqual([
      "monthly_negative_result",
      "monthly_cash_below_minimum",
    ]);
  });

  it("rejeita período inválido", async () => {
    const env = createTestEnv();
    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "monthly_close",
      period: "2026-13",
    });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// executive_overview
// ---------------------------------------------------------------------------

describe("relatorios_gerenciais — executive_overview", () => {
  it("tendência de ALTA: entradas do mês corrente 42,9% acima da média dos 2 anteriores", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);

    const res = await runSkill(relatoriosSkill, env.ctx(), { action: "executive_overview" });
    expect(res.confidence).toBe(0.9); // tendência é leitura heurística

    const data = res.data as ExecutiveOverviewData;
    expect(data.asOf).toBe("2026-08-18");
    expect(data.monthlyFlows).toEqual([
      { month: "2026-06", inflowsCents: 300_000, outflowsCents: 100_000, netCents: 200_000 },
      { month: "2026-07", inflowsCents: 400_000, outflowsCents: 150_000, netCents: 250_000 },
      { month: "2026-08", inflowsCents: 500_000, outflowsCents: 200_000, netCents: 300_000 },
    ]);
    // último = 500.000; média anteriores = 350.000 → +42,9% > +10% → alta
    expect(data.trend.direction).toBe("alta");
    expect(data.trend.lastMonthInflowsCents).toBe(500_000);
    expect(data.trend.previousTwoMonthsAvgCents).toBe(350_000);
    expect(data.trend.variationPercent).toBe(42.9);
    expect(data.trend.formula).toContain("média dos 2 meses anteriores");

    const kpiByCode = new Map(data.kpis.map((k) => [k.code, k.value]));
    expect(kpiByCode.get("saldo_disponivel")).toBe(1_950_000);
    expect(kpiByCode.get("vencidos_a_receber")).toBe(150_000);
    expect(kpiByCode.get("vencidos_a_pagar")).toBe(150_000);
    expect(kpiByCode.get("aprovacoes_pendentes")).toBe(1);
    expect(kpiByCode.get("alertas_criticos_abertos")).toBe(1);

    expect(data.opportunities.some((o) => o.includes("alta"))).toBe(true);
    expect(data.risks.some((r) => r.includes("crítico"))).toBe(true);
  });

  it("tendência de QUEDA: persiste alerta e não duplica na reexecução", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 1_000_000);
    await seedTx(env, "t1", "acc_1", "2026-06-10", 500_000);
    await seedTx(env, "t2", "acc_1", "2026-07-10", 500_000);
    await seedTx(env, "t3", "acc_1", "2026-08-05", 100_000);

    const res = await runSkill(relatoriosSkill, env.ctx(), { action: "executive_overview" });
    const data = res.data as ExecutiveOverviewData;
    // último = 100.000; média = 500.000 → −80% < −10% → queda
    expect(data.trend.direction).toBe("queda");
    expect(data.trend.variationPercent).toBe(-80);
    expect(data.risks.some((r) => r.includes("queda"))).toBe(true);
    expect(res.status).toBe("warning");

    const open = await env.repos.alerts.listOpen(env.company.id);
    expect(open.filter((a) => a.code === "report_revenue_trend_down")).toHaveLength(1);

    await runSkill(relatoriosSkill, env.ctx(), { action: "executive_overview" });
    const openAfter = await env.repos.alerts.listOpen(env.company.id);
    expect(openAfter.filter((a) => a.code === "report_revenue_trend_down")).toHaveLength(1);
  });

  it("tendência ESTÁVEL no limiar exato de +10%", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 1_000_000);
    await seedTx(env, "t1", "acc_1", "2026-06-10", 100_000);
    await seedTx(env, "t2", "acc_1", "2026-07-10", 100_000);
    await seedTx(env, "t3", "acc_1", "2026-08-05", 110_000);

    const res = await runSkill(relatoriosSkill, env.ctx(), { action: "executive_overview" });
    const data = res.data as ExecutiveOverviewData;
    // variação exatamente +10% não excede o limiar (regra: estritamente maior)
    expect(data.trend.direction).toBe("estável");
    expect(data.trend.variationPercent).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// export_data
// ---------------------------------------------------------------------------

describe("relatorios_gerenciais — export_data", () => {
  it("achata o resumo diário em linhas {metrica, valor, unidade, fonte}", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);

    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "export_data",
      report: "daily_summary",
    });
    expect(res.status).toBe("success"); // exportação não repete alertas do relatório

    const data = res.data as ExportDataData;
    expect(data.report).toBe("daily_summary");
    expect(data.title).toBe("Resumo diário");
    expect(data.subtitle).toContain("PME Teste Ltda");
    for (const row of data.rows) {
      expect(Object.keys(row).sort()).toEqual(["fonte", "metrica", "unidade", "valor"]);
    }
    const byMetric = new Map(data.rows.map((r) => [r.metrica, r]));
    expect(byMetric.get("saldo_disponivel")).toMatchObject({
      valor: 1_950_000,
      unidade: "centavos (BRL)",
    });
    expect(byMetric.get("saldo_projetado_7d")?.valor).toBe(1_920_000);
    expect(byMetric.get("aprovacoes_pendentes")).toMatchObject({ valor: 1, unidade: "quantidade" });
    expect(byMetric.has("risco_1")).toBe(true);
    expect(byMetric.has("recomendacao_1")).toBe(true);

    const events = await env.repos.events.list(env.company.id, "report.generated");
    expect(events).toHaveLength(1);
  });

  it("achata o fechamento mensal do período informado", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);

    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "export_data",
      report: "monthly_close",
      period: "2026-07",
    });
    const data = res.data as ExportDataData;
    expect(data.title).toBe("Fechamento mensal");
    expect(data.subtitle).toContain("2026-07");

    const byMetric = new Map(data.rows.map((r) => [r.metrica, r.valor]));
    expect(byMetric.get("recebimentos")).toBe(500_000);
    expect(byMetric.get("pagamentos")).toBe(310_000);
    expect(byMetric.get("dre_caixa_resultado")).toBe(190_000);
    expect(byMetric.get("saldo_disponivel_fim_do_mes")).toBe(1_650_000);
  });

  it("exige período para exportar monthly_close", async () => {
    const env = createTestEnv();
    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "export_data",
      report: "monthly_close",
    });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("validation_error");
  });

  it("achata a visão executiva com a direção da tendência", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);

    const res = await runSkill(relatoriosSkill, env.ctx(), {
      action: "export_data",
      report: "executive_overview",
    });
    expect(res.confidence).toBe(0.9);

    const data = res.data as ExportDataData;
    const byMetric = new Map(data.rows.map((r) => [r.metrica, r.valor]));
    expect(byMetric.get("tendencia_direcao")).toBe("alta");
    expect(byMetric.get("tendencia_variacao_percentual")).toBe(42.9);
    expect(byMetric.get("entradas_2026-08")).toBe(500_000);
    expect(byMetric.get("saldo_disponivel")).toBe(1_950_000);
  });
});
