/**
 * Auditoria de fórmulas — Dashboard, lado da skill de relatórios
 * (executive_overview alimenta Riscos, Oportunidades e Recomendações, e a
 * "Confiança do cálculo" exibida no rodapé do card).
 *
 * Casos de borda: base vazia, conta bancária inativa, limites de mês,
 * meses anteriores zerados (divisão indefinida), limiar exato de −10%,
 * mês corrente parcial (suposição declarada) e confiança < 1.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import { relatoriosSkill, type ExecutiveOverviewData } from "../index";

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

async function overview(env: TestEnv) {
  const res = await runSkill(relatoriosSkill, env.ctx(), { action: "executive_overview" });
  expect(res.data).not.toBeNull();
  return { res, data: res.data as ExecutiveOverviewData };
}

describe("Dashboard/relatórios — executive_overview", () => {
  it("base vazia: fluxos zerados, tendência estável, variação indefinida (null) e KPIs zero", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    const { res, data } = await overview(env);
    expect(data.monthlyFlows).toEqual([
      { month: "2026-06", inflowsCents: 0, outflowsCents: 0, netCents: 0 },
      { month: "2026-07", inflowsCents: 0, outflowsCents: 0, netCents: 0 },
      { month: "2026-08", inflowsCents: 0, outflowsCents: 0, netCents: 0 },
    ]);
    expect(data.trend.direction).toBe("estável");
    expect(data.trend.variationPercent).toBeNull();
    for (const kpi of data.kpis) expect(kpi.value).toBe(0);
    expect(res.status).toBe("success");
  });

  it("conta inativa: créditos e débitos dela ficam fora da tendência e do saldo", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 100_000);
    await seedAccount(env, "acc_off", 1_000_000, false);
    await seedTx(env, "a", "acc_1", "2026-06-10", 100_000);
    await seedTx(env, "b", "acc_1", "2026-07-10", 100_000);
    await seedTx(env, "c", "acc_1", "2026-08-10", 100_000);
    await seedTx(env, "off1", "acc_off", "2026-08-10", 900_000);
    await seedTx(env, "off2", "acc_off", "2026-08-11", -400_000);

    const { data } = await overview(env);
    expect(data.monthlyFlows[2]).toEqual({
      month: "2026-08",
      inflowsCents: 100_000,
      outflowsCents: 0,
      netCents: 100_000,
    });
    expect(data.trend.direction).toBe("estável");
    expect(data.kpis.find((k) => k.code === "saldo_disponivel")?.value).toBe(400_000);
  });

  it("limites de mês: 31/07 conta em julho e 01/08 em agosto", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedTx(env, "jul", "acc_1", "2026-07-31", 700);
    await seedTx(env, "ago", "acc_1", "2026-08-01", 800);
    const { data } = await overview(env);
    expect(data.monthlyFlows[1].inflowsCents).toBe(700);
    expect(data.monthlyFlows[2].inflowsCents).toBe(800);
  });

  it("meses anteriores zerados e mês corrente com entradas: 'alta' com variação indefinida (null)", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedTx(env, "ago", "acc_1", "2026-08-05", 1);
    const { data } = await overview(env);
    expect(data.trend.direction).toBe("alta");
    expect(data.trend.variationPercent).toBeNull();
    expect(data.trend.previousTwoMonthsAvgCents).toBe(0);
  });

  it("limiar exato de −10% é 'estável' (regra estrita); −10,05% é 'queda' mas o % exibido arredonda para −10", async () => {
    const env = createTestEnv();
    await seedAccount(env, "acc_1", 0);
    await seedTx(env, "jun", "acc_1", "2026-06-10", 100_000);
    await seedTx(env, "jul", "acc_1", "2026-07-10", 100_000);
    await seedTx(env, "ago", "acc_1", "2026-08-05", 90_000);
    const { data } = await overview(env);
    expect(data.trend.direction).toBe("estável");
    expect(data.trend.variationPercent).toBe(-10);

    const env2 = createTestEnv();
    await seedAccount(env2, "acc_1", 0);
    await seedTx(env2, "jun", "acc_1", "2026-06-10", 100_000);
    await seedTx(env2, "jul", "acc_1", "2026-07-10", 100_000);
    await seedTx(env2, "ago", "acc_1", "2026-08-05", 89_950);
    const { data: d2 } = await overview(env2);
    // Classificação usa aritmética inteira exata (89.950×20 < 200.000×9);
    // o percentual exibido é arredondado a 1 casa (Math.round(−100,5) = −100
    // → −10,0), então a tela pode mostrar "−10%" junto de "queda". Observação
    // registrada no relatório de fórmulas (apresentação, não cálculo).
    expect(d2.trend.direction).toBe("queda");
    expect(d2.trend.variationPercent).toBe(-10);
  });

  it("mês corrente parcial é declarado como suposição e a confiança é 0,9 (aparece no rodapé do card)", async () => {
    const env = createTestEnv();
    const { res } = await overview(env);
    expect(res.confidence).toBe(0.9);
    expect(res.assumptions.some((a) => a.includes("mês corrente pode estar parcial"))).toBe(true);
    expect(res.audit.data_sources).toEqual(
      expect.arrayContaining(["bank_accounts", "bank_transactions", "payables", "receivables", "approvals", "alerts"])
    );
  });
});
