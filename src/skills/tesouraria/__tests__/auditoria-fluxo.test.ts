/**
 * Auditoria de fórmulas — Fluxo de caixa (FLX-01..07 cashflow_statement).
 * Casos: base vazia (linha do tempo sempre existe, com zeros), conta inativa
 * fora do realizado e do saldo, limites inclusivos do mês e transações do
 * extrato ANTES do primeiro período entrando no saldo de partida.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import { tesourariaSkill, type CashflowStatementData } from "../index";

async function seedAccount(env: TestEnv, id: string, openingBalanceCents: number, active = true) {
  const now = env.clock.now().toISOString();
  await env.repos.bankAccounts.create({
    id,
    companyId: env.company.id,
    name: id,
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

async function seedTx(env: TestEnv, id: string, bankAccountId: string, date: string, amountCents: number) {
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

async function statement(env: TestEnv): Promise<CashflowStatementData> {
  const res = await runSkill(tesourariaSkill, env.ctx(), { action: "cashflow_statement", granularity: "monthly" });
  expect(res.data).not.toBeNull();
  return res.data as CashflowStatementData;
}

describe("Fluxo de caixa — demonstrativo mensal", () => {
  it("base vazia: 12 meses (6 passados + corrente + 5 futuros) todos zerados, saldo acumulado 0", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    const d = await statement(env);
    expect(d.buckets).toHaveLength(12);
    expect(d.buckets[0].label).toBe("2026-02");
    expect(d.buckets[6].label).toBe("2026-08");
    expect(d.buckets[11].label).toBe("2027-01");
    expect(d.period).toEqual({ start: "2026-02-01", end: "2027-01-31" });
    for (const b of d.buckets) {
      expect(b).toMatchObject({ realizedInCents: 0, realizedOutCents: 0, projectedInCents: 0, projectedOutCents: 0, netCents: 0, cumulativeBalanceCents: 0 });
    }
  });

  it("conta inativa fica fora do realizado e do saldo; extrato anterior ao 1º período entra no saldo de partida; limites do mês inclusivos", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_on", 1_000);
    await seedAccount(env, "acc_off", 900_000, false);
    await seedTx(env, "antes", "acc_on", "2026-01-31", 50); // antes de 2026-02-01: só no saldo de partida
    await seedTx(env, "jul31", "acc_on", "2026-07-31", 700);
    await seedTx(env, "ago01", "acc_on", "2026-08-01", 800);
    await seedTx(env, "ago18", "acc_on", "2026-08-18", -100); // hoje: realizado
    await seedTx(env, "off", "acc_off", "2026-08-05", 999_999);

    const d = await statement(env);
    const jul = d.buckets.find((b) => b.label === "2026-07")!;
    const ago = d.buckets.find((b) => b.label === "2026-08")!;
    expect(jul.realizedInCents).toBe(700);
    expect(ago.realizedInCents).toBe(800);
    expect(ago.realizedOutCents).toBe(100);
    // saldo de partida = 1.000 + 50; fevereiro..junho sem movimento mantêm 1.050
    expect(d.buckets[0].cumulativeBalanceCents).toBe(1_050);
    expect(jul.cumulativeBalanceCents).toBe(1_750);
    expect(ago.cumulativeBalanceCents).toBe(1_750 + 800 - 100);
  });
});
