/**
 * Auditoria de fórmulas — Dashboard, lado da skill de tesouraria.
 *
 * Cobre os casos de borda pedidos na auditoria para os números que o
 * Dashboard mostra (Saldo disponível, Comprometido e a série diária que
 * alimenta "A pagar/A receber (7 dias)" e o gráfico de 4 semanas):
 * base vazia, conta bancária inativa, título cancelado, pagamento parcial,
 * título vencido, virada de mês/ano, fuso horário (23h) e centavos exatos.
 * O cenário principal (valores exatos) está em tesouraria.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import type { Payable, Payment, Receivable } from "@/core/entities";
import { tesourariaSkill, type CashPositionData, type RefreshProjectionData } from "../index";

// ---------------------------------------------------------------------------
// Fábricas mínimas
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
    bankCode: "341",
    agency: "0001",
    accountNumberMasked: "****0001",
    type: "checking",
    currency: "BRL",
    openingBalanceCents,
    openingBalanceDate: "2026-01-01",
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
    description: id,
    source: "ofx",
    reconciled: false,
    createdAt: env.clock.now().toISOString(),
  });
}

async function seedPayable(
  env: TestEnv,
  seed: Pick<Payable, "id" | "dueDate" | "amountCents"> &
    Partial<Pick<Payable, "paidCents" | "status" | "canceledAt" | "issueDate">>
): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.payables.create({
    id: seed.id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: seed.id,
    issueDate: seed.issueDate ?? "2026-01-01",
    dueDate: seed.dueDate,
    amountCents: seed.amountCents,
    paidCents: seed.paidCents ?? 0,
    currency: "BRL",
    status: seed.status ?? "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: seed.id,
    canceledAt: seed.canceledAt,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedReceivable(
  env: TestEnv,
  seed: Pick<Receivable, "id" | "dueDate" | "amountCents"> &
    Partial<Pick<Receivable, "receivedCents" | "status" | "canceledAt">>
): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.receivables.create({
    id: seed.id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: seed.id,
    issueDate: "2026-01-01",
    dueDate: seed.dueDate,
    amountCents: seed.amountCents,
    receivedCents: seed.receivedCents ?? 0,
    currency: "BRL",
    status: seed.status ?? "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: seed.id,
    canceledAt: seed.canceledAt,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPayment(
  env: TestEnv,
  seed: Pick<Payment, "id" | "payableId" | "amountCents" | "scheduledDate" | "status">
): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.payments.create({
    id: seed.id,
    companyId: env.company.id,
    payableId: seed.payableId,
    bankAccountId: "acc_1",
    amountCents: seed.amountCents,
    scheduledDate: seed.scheduledDate,
    status: seed.status,
    requestedBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  });
}

async function cashPosition(env: TestEnv): Promise<CashPositionData> {
  const res = await runSkill(tesourariaSkill, env.ctx(), { action: "cash_position" });
  expect(res.status).toBe("success");
  return res.data as CashPositionData;
}

async function projection(env: TestEnv, horizonDays = 90): Promise<RefreshProjectionData> {
  const res = await runSkill(tesourariaSkill, env.ctx(), {
    action: "refresh_projection",
    horizonDays,
  });
  expect(res.data).not.toBeNull();
  return res.data as RefreshProjectionData;
}

function pointOf(data: RefreshProjectionData, date: string) {
  return data.daily.find((d) => d.date === date);
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

describe("Dashboard/tesouraria — base vazia", () => {
  it("sem contas nem títulos: disponível, comprometido e projeção zerados; série só com hoje", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    const cash = await cashPosition(env);
    expect(cash.accounts).toEqual([]);
    expect(cash.totals).toEqual({ availableCents: 0, committedCents: 0, projected30Cents: 0 });

    const proj = await projection(env, 7);
    expect(proj.daily).toEqual([
      { date: "2026-08-18", inCents: 0, outCents: 0, balanceCents: 0 },
    ]);
    expect(proj.summary.endingBalanceCents).toBe(0);
    expect(proj.summary.minBalanceCents).toBe(0);
    expect(proj.summary.horizonEnd).toBe("2026-08-25");
  });
});

describe("Dashboard/tesouraria — fonte do Saldo disponível (card com detalhes)", () => {
  it("lista as contas ativas com banco, número mascarado, saldo e último lote; a soma das contas é o total", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 100_000);
    await seedAccount(env, "acc_2", 50_000);
    await seedAccount(env, "acc_off", 9_000_000, false);
    await seedTx(env, "t1", "acc_1", "2026-08-10", 25_000);
    await seedTx(env, "t2", "acc_1", "2026-08-11", -5_000);
    const now = env.clock.now().toISOString();
    await env.repos.statementImports.create({
      id: "imp_old",
      companyId: env.company.id,
      bankAccountId: "acc_1",
      format: "ofx",
      source: "ofx",
      imported: 1,
      duplicates: 0,
      warnings: [],
      createdBy: "usr_analyst",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    await env.repos.statementImports.create({
      id: "imp_new",
      companyId: env.company.id,
      bankAccountId: "acc_1",
      format: "mock",
      source: "sync",
      imported: 1,
      duplicates: 0,
      warnings: [],
      createdBy: "system",
      createdAt: now,
    });

    const cash = await cashPosition(env);
    expect(cash.accounts.map((a) => a.id)).toEqual(["acc_1", "acc_2"]);
    expect(cash.accounts[0]).toMatchObject({
      bankCode: "341",
      accountNumberMasked: "****0001",
      availableCents: 120_000,
      transactionCount: 2,
      lastImport: { source: "sync", format: "mock", at: now, imported: 1 },
    });
    expect(cash.accounts[1].lastImport).toBeUndefined();
    expect(cash.accounts[1].transactionCount).toBe(0);
    // Identidade: Σ contas listadas = total do card.
    expect(cash.accounts.reduce((s, a) => s + a.availableCents, 0)).toBe(cash.totals.availableCents);
    expect(cash.totals.availableCents).toBe(170_000);
    expect(cash.source).toEqual({
      tables: ["bank_accounts", "bank_transactions", "statement_imports"],
      provider: "mock",
      activeAccountCount: 2,
      lastImportAt: now,
    });
  });

  it("sem lotes em nenhuma conta, lastImportAt fica ausente", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 1);
    const cash = await cashPosition(env);
    expect(cash.source.lastImportAt).toBeUndefined();
    expect(cash.source.activeAccountCount).toBe(1);
  });
});

describe("Dashboard/tesouraria — conta bancária inativa", () => {
  it("conta inativa fica fora do disponível, da lista de contas e da projeção", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 100_000, true);
    await seedAccount(env, "acc_off", 9_000_000, false);
    await seedTx(env, "t1", "acc_1", "2026-08-10", 25_000);
    await seedTx(env, "t_off", "acc_off", "2026-08-10", 5_000_000);

    const cash = await cashPosition(env);
    expect(cash.accounts.map((a) => a.id)).toEqual(["acc_1"]);
    expect(cash.totals.availableCents).toBe(125_000);

    const proj = await projection(env);
    expect(proj.summary.openingBalanceCents).toBe(125_000);
  });
});

describe("Dashboard/tesouraria — título cancelado", () => {
  it("payable/receivable cancelados e payment cancelado/rejeitado não entram em nada", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, {
      id: "pay_cancel",
      dueDate: "2026-08-20",
      amountCents: 70_000,
      status: "canceled",
      canceledAt: env.clock.now().toISOString(),
    });
    await seedReceivable(env, {
      id: "rec_cancel",
      dueDate: "2026-08-20",
      amountCents: 80_000,
      status: "canceled",
      canceledAt: env.clock.now().toISOString(),
    });
    // Pagamento cancelado/rejeitado de um título agendado: o TÍTULO ainda conta
    // (saldo restante), mas o pagamento não.
    await seedPayable(env, { id: "pay_sched", dueDate: "2026-08-22", amountCents: 10_000, status: "scheduled" });
    await seedPayment(env, { id: "pmt_rej", payableId: "pay_sched", amountCents: 10_000, scheduledDate: "2026-08-21", status: "rejected" });
    await seedPayment(env, { id: "pmt_can", payableId: "pay_sched", amountCents: 10_000, scheduledDate: "2026-08-21", status: "canceled" });

    const cash = await cashPosition(env);
    // comprometido = payable agendado sem payment pendente (10.000); nada dos cancelados
    expect(cash.totals.committedCents).toBe(10_000);

    const proj = await projection(env, 30);
    expect(proj.summary.totalInCents).toBe(0);
    expect(proj.summary.totalOutCents).toBe(10_000);
    expect(pointOf(proj, "2026-08-20")).toBeUndefined();
    expect(pointOf(proj, "2026-08-22")?.outCents).toBe(10_000); // dueDate, pois não há payment pendente
  });
});

describe("Dashboard/tesouraria — pagamento parcial", () => {
  it("títulos parcialmente liquidados entram pelo saldo restante (valor − liquidado)", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, { id: "pay_p", dueDate: "2026-08-20", amountCents: 100_000, paidCents: 30_000, status: "partially_paid" });
    await seedReceivable(env, { id: "rec_p", dueDate: "2026-08-21", amountCents: 50_000, receivedCents: 12_345, status: "partially_received" });

    const proj = await projection(env, 30);
    expect(pointOf(proj, "2026-08-20")?.outCents).toBe(70_000);
    expect(pointOf(proj, "2026-08-21")?.inCents).toBe(37_655);
    expect(proj.summary.endingBalanceCents).toBe(37_655 - 70_000);
  });

  it("título com liquidação completa mas status ainda aberto (saldo 0) não gera movimento", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, { id: "pay_zero", dueDate: "2026-08-20", amountCents: 100_000, paidCents: 100_000, status: "partially_paid" });
    const proj = await projection(env, 30);
    expect(proj.summary.totalOutCents).toBe(0);
  });
});

describe("Dashboard/tesouraria — título vencido", () => {
  it("vencidos (título e pagamento agendado no passado) entram em HOJE, não na data original", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, { id: "pay_old", dueDate: "2026-07-01", amountCents: 1_000 });
    await seedReceivable(env, { id: "rec_old", dueDate: "2026-08-17", amountCents: 2_000 });
    await seedPayable(env, { id: "pay_sched", dueDate: "2026-09-30", amountCents: 4_000, status: "scheduled" });
    await seedPayment(env, { id: "pmt_old", payableId: "pay_sched", amountCents: 4_000, scheduledDate: "2026-08-10", status: "approved" });

    const proj = await projection(env, 30);
    const today = pointOf(proj, "2026-08-18");
    expect(today).toEqual({ date: "2026-08-18", inCents: 2_000, outCents: 5_000, balanceCents: -3_000 });
    expect(pointOf(proj, "2026-07-01")).toBeUndefined();
    expect(pointOf(proj, "2026-08-10")).toBeUndefined();
    expect(proj.daily[0].date).toBe("2026-08-18"); // a série nunca começa antes de hoje
  });

  it("vence hoje não é vencido: entra em hoje pela própria data", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, { id: "pay_today", dueDate: "2026-08-18", amountCents: 500 });
    const proj = await projection(env, 7);
    expect(pointOf(proj, "2026-08-18")?.outCents).toBe(500);
    // Sem vencidos, a recomendação de cobrança de vencidos não aparece.
    expect(proj.recommendations.some((r) => r.includes("vencidos"))).toBe(false);
  });
});

describe("Dashboard/tesouraria — virada de mês e de ano", () => {
  it("horizonte de 7 dias a partir de 30/12 vai até 06/01 do ano seguinte (inclusivo)", async () => {
    const env = createTestEnv("2026-12-30T15:00:00Z"); // hoje = 2026-12-30
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, { id: "p1", dueDate: "2026-12-31", amountCents: 1 });
    await seedPayable(env, { id: "p2", dueDate: "2027-01-01", amountCents: 2 });
    await seedPayable(env, { id: "p3", dueDate: "2027-01-06", amountCents: 4 }); // hoje + 7
    await seedPayable(env, { id: "p4", dueDate: "2027-01-07", amountCents: 8 }); // hoje + 8: fora

    const proj = await projection(env, 7);
    expect(proj.summary.horizonStart).toBe("2026-12-30");
    expect(proj.summary.horizonEnd).toBe("2027-01-06");
    expect(proj.daily.map((d) => [d.date, d.outCents])).toEqual([
      ["2026-12-30", 0],
      ["2026-12-31", 1],
      ["2027-01-01", 2],
      ["2027-01-06", 4],
    ]);
    expect(proj.summary.totalOutCents).toBe(7);
  });

  it("virada de mês: 30/08 + 7 = 06/09", async () => {
    const env = createTestEnv("2026-08-30T15:00:00Z");
    await seedAccount(env, "acc_1", 0);
    await seedReceivable(env, { id: "r1", dueDate: "2026-09-06", amountCents: 10 });
    await seedReceivable(env, { id: "r2", dueDate: "2026-09-07", amountCents: 20 });
    const proj = await projection(env, 7);
    expect(proj.summary.horizonEnd).toBe("2026-09-06");
    expect(proj.summary.totalInCents).toBe(10);
  });
});

describe("Dashboard/tesouraria — fuso horário", () => {
  it("às 23h30 de 17/08 em São Paulo (02h30 UTC de 18/08) o 'hoje' da skill é 17/08", async () => {
    const env = createTestEnv("2026-08-18T02:30:00Z");
    await seedAccount(env, "acc_1", 0);
    await seedPayable(env, { id: "p17", dueDate: "2026-08-17", amountCents: 100 });
    await seedPayable(env, { id: "p18", dueDate: "2026-08-18", amountCents: 200 });

    const cash = await cashPosition(env);
    expect(cash.period.asOf).toBe("2026-08-17");

    const proj = await projection(env, 7);
    expect(proj.summary.horizonStart).toBe("2026-08-17");
    // p17 vence hoje (não é vencido) e p18 vence amanhã: dois pontos distintos.
    expect(pointOf(proj, "2026-08-17")?.outCents).toBe(100);
    expect(pointOf(proj, "2026-08-18")?.outCents).toBe(200);
  });
});

describe("Dashboard/tesouraria — centavos", () => {
  it("valores ímpares somam exatos: 333 + 667 = 1.000; nada é arredondado (100% de realização)", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 1);
    await seedTx(env, "t1", "acc_1", "2026-08-01", 333);
    await seedTx(env, "t2", "acc_1", "2026-08-02", -667);
    await seedReceivable(env, { id: "r1", dueDate: "2026-08-20", amountCents: 333 });
    await seedReceivable(env, { id: "r2", dueDate: "2026-08-20", amountCents: 667 });

    const cash = await cashPosition(env);
    expect(cash.totals.availableCents).toBe(1 + 333 - 667);

    const proj = await projection(env, 30);
    expect(pointOf(proj, "2026-08-20")?.inCents).toBe(1_000);
    expect(proj.summary.endingBalanceCents).toBe(1 + 333 - 667 + 1_000);
  });
});
