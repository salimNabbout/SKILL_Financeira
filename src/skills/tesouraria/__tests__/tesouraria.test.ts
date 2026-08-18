import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import {
  tesourariaSkill,
  type CashPositionData,
  type CashflowStatementData,
  type RefreshProjectionData,
  type ScenariosData,
} from "../index";

/**
 * Cenário determinístico (relógio fixo em 2026-08-18T15:00:00Z → hoje =
 * 2026-08-18 em America/Sao_Paulo):
 *
 * Contas: acc_main (abertura 10.000,00 + 5.000,00 − 2.000,00 = 13.000,00) e
 * acc_reserve (abertura 2.000,00) → disponível total 15.000,00.
 *
 * Recebíveis: rec_1 4.000,00 vence 25/08; rec_2 restante 2.000,00 vencido em
 * 10/08 (entra hoje); rec_3 1.000,00 vence 31/12 (fora do horizonte de 90d).
 *
 * Payables: pay_1 3.500,00 vence 22/08; pay_2 2.500,00 agendado com payment
 * pendente pmt_1 (scheduledDate 27/08); pay_3 1.500,00 vencido 01/08 (entra
 * hoje); pay_4 1.200,00 agendado sem payment, vence 05/09.
 *
 * Comprometido = pmt_1 (2.500,00) + pay_4 (1.200,00) = 3.700,00.
 */
async function seedMainScenario(env: TestEnv): Promise<void> {
  const companyId = env.company.id;
  const now = env.clock.now().toISOString();

  await env.repos.bankAccounts.create({
    id: "acc_main",
    companyId,
    name: "Conta Principal",
    bankCode: "001",
    agency: "0001",
    accountNumberMasked: "***1234",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 1_000_000,
    openingBalanceDate: "2026-08-01",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await env.repos.bankAccounts.create({
    id: "acc_reserve",
    companyId,
    name: "Conta Reserva",
    bankCode: "237",
    agency: "0002",
    accountNumberMasked: "***9876",
    type: "savings",
    currency: "BRL",
    openingBalanceCents: 200_000,
    openingBalanceDate: "2026-08-01",
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  await env.repos.bankTransactions.create({
    id: "tx_1",
    companyId,
    bankAccountId: "acc_main",
    date: "2026-08-05",
    amountCents: 500_000,
    currency: "BRL",
    description: "PIX recebido",
    source: "ofx",
    reconciled: false,
    createdAt: now,
  });
  await env.repos.bankTransactions.create({
    id: "tx_2",
    companyId,
    bankAccountId: "acc_main",
    date: "2026-08-10",
    amountCents: -200_000,
    currency: "BRL",
    description: "Pagamento fornecedor",
    source: "ofx",
    reconciled: false,
    createdAt: now,
  });

  const receivableBase = {
    companyId,
    customerId: "cus_1",
    issueDate: "2026-08-01" as const,
    currency: "BRL" as const,
    installmentNumber: 1,
    installmentCount: 1,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  };
  await env.repos.receivables.create({
    ...receivableBase,
    id: "rec_1",
    description: "Venda 1",
    dueDate: "2026-08-25",
    amountCents: 400_000,
    receivedCents: 0,
    status: "open",
    originKey: "rec-1",
  });
  await env.repos.receivables.create({
    ...receivableBase,
    id: "rec_2",
    description: "Venda 2 (parcial, vencida)",
    dueDate: "2026-08-10",
    amountCents: 300_000,
    receivedCents: 100_000,
    status: "partially_received",
    originKey: "rec-2",
  });
  await env.repos.receivables.create({
    ...receivableBase,
    id: "rec_3",
    description: "Venda 3 (fora do horizonte)",
    dueDate: "2026-12-31",
    amountCents: 100_000,
    receivedCents: 0,
    status: "open",
    originKey: "rec-3",
  });

  const payableBase = {
    companyId,
    supplierId: "sup_1",
    issueDate: "2026-08-01" as const,
    paidCents: 0,
    currency: "BRL" as const,
    installmentNumber: 1,
    installmentCount: 1,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  };
  await env.repos.payables.create({
    ...payableBase,
    id: "pay_1",
    description: "Fornecedor A",
    dueDate: "2026-08-22",
    amountCents: 350_000,
    status: "open",
    originKey: "pay-1",
  });
  await env.repos.payables.create({
    ...payableBase,
    id: "pay_2",
    description: "Fornecedor B (agendado com payment pendente)",
    dueDate: "2026-08-28",
    amountCents: 250_000,
    status: "scheduled",
    originKey: "pay-2",
  });
  await env.repos.payables.create({
    ...payableBase,
    id: "pay_3",
    description: "Fornecedor C (vencido)",
    dueDate: "2026-08-01",
    amountCents: 150_000,
    status: "open",
    originKey: "pay-3",
  });
  await env.repos.payables.create({
    ...payableBase,
    id: "pay_4",
    description: "Fornecedor D (agendado sem payment)",
    dueDate: "2026-09-05",
    amountCents: 120_000,
    status: "scheduled",
    originKey: "pay-4",
  });

  await env.repos.payments.create({
    id: "pmt_1",
    companyId,
    payableId: "pay_2",
    bankAccountId: "acc_main",
    amountCents: 250_000,
    scheduledDate: "2026-08-27",
    status: "pending_approval",
    method: "pix",
    requestedBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  });
}

describe("tesouraria_fluxo_caixa — cash_position", () => {
  it("calcula disponível por conta, comprometido e projetado 30 dias com valores exatos", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const res = await tesourariaSkill.execute(env.ctx(), { action: "cash_position" });
    const data = res.data as CashPositionData;

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    expect(data.accounts).toEqual([
      { id: "acc_main", name: "Conta Principal", availableCents: 1_300_000 },
      { id: "acc_reserve", name: "Conta Reserva", availableCents: 200_000 },
    ]);
    expect(data.totals.availableCents).toBe(1_500_000);
    // pmt_1 (250.000) + pay_4 agendado sem payment (120.000); pay_2 NÃO conta
    // duas vezes (só o payment pendente entra).
    expect(data.totals.committedCents).toBe(370_000);
    // 1.500.000 + (200.000 + 400.000) − (150.000 + 350.000 + 250.000 + 120.000)
    expect(data.totals.projected30Cents).toBe(1_230_000);
    expect(data.formulas.available).toContain("openingBalanceCents");
    expect(data.formulas.committed).toContain("pending_approval");
    expect(data.period.asOf).toBe("2026-08-18");
    expect(res.audit.data_sources).toEqual([
      "bank_accounts",
      "bank_transactions",
      "payments",
      "payables",
      "receivables",
    ]);
  });

  it("resultado é estável em chamadas repetidas (leitura pura, sem efeitos)", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const first = await tesourariaSkill.execute(env.ctx(), { action: "cash_position" });
    const second = await tesourariaSkill.execute(env.ctx(), { action: "cash_position" });
    expect((second.data as CashPositionData).totals).toEqual(
      (first.data as CashPositionData).totals
    );
    expect(await env.repos.alerts.listOpen(env.company.id)).toHaveLength(0);
  });
});

describe("tesouraria_fluxo_caixa — refresh_projection", () => {
  it("projeta o fluxo diário acumulado com valores exatos e publica cashflow.updated", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const res = await tesourariaSkill.execute(env.ctx(), {
      action: "refresh_projection",
      horizonDays: 90,
    });
    const data = res.data as RefreshProjectionData;

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    expect(data.summary).toEqual({
      horizonStart: "2026-08-18",
      horizonEnd: "2026-11-16",
      openingBalanceCents: 1_500_000,
      totalInCents: 600_000,
      totalOutCents: 870_000,
      endingBalanceCents: 1_230_000,
      minBalanceCents: 1_200_000,
      minBalanceDate: "2026-08-22",
    });
    // Apenas dias com movimento + hoje; vencidos (rec_2, pay_3) entram hoje;
    // pay_2 entra na scheduledDate do payment pendente (27/08).
    expect(data.daily).toEqual([
      { date: "2026-08-18", inCents: 200_000, outCents: 150_000, balanceCents: 1_550_000 },
      { date: "2026-08-22", inCents: 0, outCents: 350_000, balanceCents: 1_200_000 },
      { date: "2026-08-25", inCents: 400_000, outCents: 0, balanceCents: 1_600_000 },
      { date: "2026-08-27", inCents: 0, outCents: 250_000, balanceCents: 1_350_000 },
      { date: "2026-09-05", inCents: 0, outCents: 120_000, balanceCents: 1_230_000 },
    ]);
    expect(data.recommendations.some((r) => r.includes("Intensificar cobrança"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("vencidos") || a.includes("hoje"))).toBe(true);

    const updated = await env.repos.events.list(env.company.id, "cashflow.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].payload).toMatchObject({
      horizonDays: 90,
      endingBalanceCents: 1_230_000,
      minBalanceCents: 1_200_000,
    });
    // Sem insuficiência e acima do caixa mínimo: nenhum alerta persistido.
    expect(await env.repos.alerts.listOpen(env.company.id)).toHaveLength(0);
    expect(await env.repos.events.list(env.company.id, "cashflow.shortfall_detected")).toHaveLength(
      0
    );
  });

  it("detecta insuficiência: alerta crítico persistido, evento publicado, auditoria e dedupe ao rodar 2x", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const now = env.clock.now().toISOString();
    // Saída extra de R$ 30.000,00 em 20/08 leva o saldo projetado a negativo.
    await env.repos.payables.create({
      id: "pay_big",
      companyId: env.company.id,
      supplierId: "sup_1",
      description: "Compra de máquina",
      issueDate: "2026-08-01",
      dueDate: "2026-08-20",
      amountCents: 3_000_000,
      paidCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "pay-big",
      createdBy: "usr_analyst",
      createdAt: now,
      updatedAt: now,
    });

    const res = await tesourariaSkill.execute(env.ctx(), { action: "refresh_projection" });
    const data = res.data as RefreshProjectionData;

    expect(data.summary.minBalanceCents).toBe(-1_800_000);
    expect(data.summary.minBalanceDate).toBe("2026-08-22");
    expect(data.summary.endingBalanceCents).toBe(-1_770_000);
    expect(res.status).toBe("warning");
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]).toMatchObject({ severity: "critical", code: "cash_shortfall_projected" });
    expect(res.alerts[0].message).toContain("22/08/2026");
    expect(data.recommendations.some((r) => r.includes("Insuficiência projetada"))).toBe(true);

    const open = await env.repos.alerts.listOpen(env.company.id);
    expect(open.filter((a) => a.code === "cash_shortfall_projected")).toHaveLength(1);
    expect(open[0].severity).toBe("critical");
    expect(open[0].source).toBe("tesouraria_fluxo_caixa");

    const shortfallEvents = await env.repos.events.list(
      env.company.id,
      "cashflow.shortfall_detected"
    );
    expect(shortfallEvents).toHaveLength(1);
    expect(shortfallEvents[0].payload).toMatchObject({
      minBalanceCents: -1_800_000,
      minBalanceDate: "2026-08-22",
      horizonDays: 90,
    });

    const audit = await env.repos.audit.list(env.company.id, { entityType: "alert" });
    expect(audit.some((a) => a.action === "alert.created")).toBe(true);

    // Segunda execução: NÃO duplica o alerta aberto (dedupe por code).
    const second = await tesourariaSkill.execute(env.ctx(), { action: "refresh_projection" });
    const openAfter = await env.repos.alerts.listOpen(env.company.id);
    expect(openAfter.filter((a) => a.code === "cash_shortfall_projected")).toHaveLength(1);
    expect(second.assumptions.some((a) => a.includes("não foi duplicado"))).toBe(true);
    // cashflow.updated é publicado em toda execução.
    expect(await env.repos.events.list(env.company.id, "cashflow.updated")).toHaveLength(2);
  });

  it("emite warning quando o mínimo projetado fica abaixo do caixa mínimo de segurança", async () => {
    const env = createTestEnv();
    const companyId = env.company.id;
    const now = env.clock.now().toISOString();
    await env.repos.bankAccounts.create({
      id: "acc_small",
      companyId,
      name: "Conta Única",
      bankCode: "001",
      agency: "0001",
      accountNumberMasked: "***0001",
      type: "checking",
      currency: "BRL",
      openingBalanceCents: 500_000,
      openingBalanceDate: "2026-08-01",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await env.repos.payables.create({
      id: "pay_small",
      companyId,
      supplierId: "sup_1",
      description: "Aluguel",
      issueDate: "2026-08-01",
      dueDate: "2026-08-20",
      amountCents: 100_000,
      paidCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "pay-small",
      createdBy: "usr_analyst",
      createdAt: now,
      updatedAt: now,
    });

    const res = await tesourariaSkill.execute(env.ctx(), { action: "refresh_projection" });
    const data = res.data as RefreshProjectionData;

    // Hoje sempre presente no diário, mesmo sem movimento.
    expect(data.daily[0]).toEqual({
      date: "2026-08-18",
      inCents: 0,
      outCents: 0,
      balanceCents: 500_000,
    });
    expect(data.summary.minBalanceCents).toBe(400_000);
    expect(data.summary.minBalanceDate).toBe("2026-08-20");
    expect(res.alerts[0]).toMatchObject({ severity: "warning", code: "cash_below_minimum" });

    const open = await env.repos.alerts.listOpen(companyId);
    expect(open.filter((a) => a.code === "cash_below_minimum")).toHaveLength(1);
    // Abaixo do mínimo, mas sem insuficiência: não publica shortfall.
    expect(await env.repos.events.list(companyId, "cashflow.shortfall_detected")).toHaveLength(0);
  });
});

describe("tesouraria_fluxo_caixa — cashflow_statement", () => {
  it("mensal: realizado por transações bancárias e projetado à frente, com acumulado exato", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const res = await tesourariaSkill.execute(env.ctx(), {
      action: "cashflow_statement",
      granularity: "monthly",
      periods: 4,
    });
    const data = res.data as CashflowStatementData;

    expect(res.status).toBe("success");
    expect(data.granularity).toBe("monthly");
    // floor(4/2)=2 períodos passados + corrente + 1 futuro.
    expect(data.buckets.map((b) => b.label)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(data.buckets[0]).toMatchObject({
      start: "2026-06-01",
      end: "2026-06-30",
      realizedInCents: 0,
      realizedOutCents: 0,
      projectedInCents: 0,
      projectedOutCents: 0,
      netCents: 0,
      // Saldo inicial = aberturas (1.000.000 + 200.000), sem transações antes de jun.
      cumulativeBalanceCents: 1_200_000,
    });
    expect(data.buckets[1].cumulativeBalanceCents).toBe(1_200_000);
    // Agosto (corrente): realizado até hoje + projetado de hoje ao fim do mês.
    expect(data.buckets[2]).toMatchObject({
      start: "2026-08-01",
      end: "2026-08-31",
      realizedInCents: 500_000,
      realizedOutCents: 200_000,
      projectedInCents: 600_000,
      projectedOutCents: 750_000,
      netCents: 150_000,
      cumulativeBalanceCents: 1_350_000,
    });
    expect(data.buckets[3]).toMatchObject({
      start: "2026-09-01",
      end: "2026-09-30",
      realizedInCents: 0,
      realizedOutCents: 0,
      projectedInCents: 0,
      projectedOutCents: 120_000,
      netCents: -120_000,
      cumulativeBalanceCents: 1_230_000,
    });
    expect(data.formula).toContain("transações bancárias");
    expect(res.assumptions.some((a) => a.includes("fonte primária"))).toBe(true);
  });

  it("usa defaults de períodos por granularidade e semanas iniciando na segunda-feira", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const res = await tesourariaSkill.execute(env.ctx(), {
      action: "cashflow_statement",
      granularity: "weekly",
    });
    const data = res.data as CashflowStatementData;
    expect(data.buckets).toHaveLength(8);
    // 2026-08-18 é terça; a semana corrente começa em 17/08 (segunda).
    const current = data.buckets[4]; // floor(8/2)=4 semanas passadas antes da corrente
    expect(current.start).toBe("2026-08-17");
    expect(current.end).toBe("2026-08-23");
    // Realizado da semana corrente: nenhum (transações em 05 e 10/08).
    expect(current.realizedInCents).toBe(0);
    // Projetado na semana corrente: entradas de hoje (200.000) e saídas 18+22/08.
    expect(current.projectedInCents).toBe(200_000);
    expect(current.projectedOutCents).toBe(500_000);
  });
});

describe("tesouraria_fluxo_caixa — scenarios", () => {
  it("calcula os três cenários com matemática exata de percentuais e atrasos", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const res = await tesourariaSkill.execute(env.ctx(), { action: "scenarios", horizonDays: 90 });
    const data = res.data as ScenariosData;

    expect(res.confidence).toBe(0.6);
    expect(data.horizonDays).toBe(90);
    expect(data.scenarios).toHaveLength(3);

    const [otimista, base, pessimista] = data.scenarios;

    // Otimista: 100% na data; vencido (200.000) em hoje+7 = 25/08.
    // Entradas 600.000 em 25/08; saídas 870.000 → final 1.230.000; mínimo em 22/08.
    expect(otimista).toEqual({
      name: "otimista",
      endingBalanceCents: 1_230_000,
      minBalanceCents: 1_000_000,
      minBalanceDate: "2026-08-22",
      params: { realizationPercent: 100, delayDays: 0, overdueDelayDays: 7 },
    });

    // Base: 95% com +7 dias (rec_1: 380.000 em 01/09); vencido em hoje+21
    // (rec_2: 190.000 em 08/09) → final 1.500.000 + 570.000 − 870.000.
    expect(base).toEqual({
      name: "base",
      endingBalanceCents: 1_200_000,
      minBalanceCents: 750_000,
      minBalanceDate: "2026-08-27",
      params: { realizationPercent: 95, delayDays: 7, overdueDelayDays: 21 },
    });

    // Pessimista: 80% com +21 dias (rec_1: 320.000 em 15/09); vencido em
    // hoje+45 (rec_2: 160.000 em 02/10) → final 1.500.000 + 480.000 − 870.000.
    expect(pessimista).toEqual({
      name: "pessimista",
      endingBalanceCents: 1_110_000,
      minBalanceCents: 630_000,
      minBalanceDate: "2026-09-05",
      params: { realizationPercent: 80, delayDays: 21, overdueDelayDays: 45 },
    });

    expect(res.assumptions.some((a) => a.includes("95%"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("obrigação"))).toBe(true);
    expect(data.formula).toContain("realizationPercent");
  });
});

describe("tesouraria_fluxo_caixa — validação de entrada", () => {
  it("rejeita ação desconhecida e granularity ausente via runSkill", async () => {
    const env = createTestEnv();
    const bad = await runSkill(tesourariaSkill, env.ctx(), { action: "inexistente" });
    expect(bad.status).toBe("error");
    expect(bad.alerts[0].code).toBe("invalid_input");

    const missing = await runSkill(tesourariaSkill, env.ctx(), { action: "cashflow_statement" });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("invalid_input");

    const badHorizon = await runSkill(tesourariaSkill, env.ctx(), {
      action: "refresh_projection",
      horizonDays: 0,
    });
    expect(badHorizon.status).toBe("error");
    expect(badHorizon.alerts[0].code).toBe("invalid_input");
  });

  it("aceita o contrato dos fluxos: refresh_projection com horizonDays 90 devolve summary e daily", async () => {
    const env = createTestEnv();
    await seedMainScenario(env);
    const res = await runSkill(tesourariaSkill, env.ctx(), {
      action: "refresh_projection",
      horizonDays: 90,
    });
    const data = res.data as RefreshProjectionData;
    expect(data.summary.horizonEnd).toBe("2026-11-16");
    expect(data.summary.totalOutCents).toBe(870_000);
    expect(Array.isArray(data.daily)).toBe(true);
  });
});
