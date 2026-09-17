/**
 * Auditoria de fórmulas — Fechamento mensal (REL-12..REL-17). Casos que o
 * cenário principal não cobre: recibo estornado, limites inclusivos do mês,
 * virada de ano e base vazia. A data de caixa dos pagamentos é
 * Payment.scheduledDate (regra atual, registrada no relatório como decisão
 * pendente S-04); os casos abaixo não dependem dela.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import { relatoriosSkill, type MonthlyCloseData } from "../index";

let seq = 0;

async function seedReceivable(env: TestEnv, id: string, amountCents: number): Promise<void> {
  const now = env.clock.now().toISOString();
  await env.repos.receivables.create({
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: id,
    issueDate: "2026-06-01",
    dueDate: "2026-07-15",
    amountCents,
    receivedCents: amountCents,
    currency: "BRL",
    status: "received",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedReceipt(
  env: TestEnv,
  receivableId: string,
  amountCents: number,
  receivedDate: string,
  status?: "registered" | "canceled"
): Promise<void> {
  await env.repos.receipts.create({
    id: `rcp_${++seq}`,
    companyId: env.company.id,
    receivableId,
    bankAccountId: "acc_1",
    amountCents,
    receivedDate,
    method: "pix",
    status,
    registeredBy: "usr",
    createdAt: env.clock.now().toISOString(),
  });
}

async function close(env: TestEnv, period: string): Promise<MonthlyCloseData> {
  const res = await runSkill(relatoriosSkill, env.ctx(), { action: "monthly_close", period });
  expect(res.data).not.toBeNull();
  return res.data as MonthlyCloseData;
}

describe("Fechamento mensal — recebimentos", () => {
  it("recibo ESTORNADO (status canceled) não entra nos recebimentos do mês", async () => {
    const env = createTestEnv();
    await seedReceivable(env, "rcv_1", 10_000);
    await seedReceipt(env, "rcv_1", 10_000, "2026-07-10", "registered");
    await seedReceipt(env, "rcv_1", 99_999, "2026-07-11", "canceled");
    const d = await close(env, "2026-07");
    expect(d.facts.receiptsCents).toBe(10_000);
    expect(d.calculations.dreSimplificada.receitaCents).toBe(10_000);
  });

  it("limites inclusivos: 31/07 entra em julho, 01/08 não; recibo sem status (legado) vale", async () => {
    const env = createTestEnv();
    await seedReceivable(env, "rcv_1", 30_000);
    await seedReceipt(env, "rcv_1", 1, "2026-07-01");
    await seedReceipt(env, "rcv_1", 10, "2026-07-31");
    await seedReceipt(env, "rcv_1", 100, "2026-08-01");
    expect((await close(env, "2026-07")).facts.receiptsCents).toBe(11);
    expect((await close(env, "2026-08")).facts.receiptsCents).toBe(100);
  });

  it("virada de ano: dezembro fecha em 31/12 e o recibo de 01/01 fica para janeiro", async () => {
    const env = createTestEnv("2027-01-05T15:00:00Z");
    await seedReceivable(env, "rcv_1", 1_000);
    await seedReceipt(env, "rcv_1", 700, "2026-12-31");
    await seedReceipt(env, "rcv_1", 300, "2027-01-01");
    const dez = await close(env, "2026-12");
    expect(dez.calculations.period).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(dez.facts.receiptsCents).toBe(700);
    expect((await close(env, "2027-01")).facts.receiptsCents).toBe(300);
  });

  it("base vazia: todos os fatos zerados e resultado zero", async () => {
    const env = createTestEnv();
    const d = await close(env, "2026-07");
    expect(d.facts).toEqual({
      receiptsCents: 0,
      paymentsCents: 0,
      newPayablesCents: 0,
      newReceivablesCents: 0,
      endOfMonthAvailableCents: 0,
    });
    expect(d.calculations.netCashFlowCents).toBe(0);
  });
});
