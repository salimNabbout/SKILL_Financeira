/**
 * Auditoria de fórmulas — DRE gerencial e Indicadores (DRE-01..12, IND-01..10).
 * Casos de borda que o cenário principal (controladoria.test.ts) não cobre:
 * virada de ano por competência, categoria inativa, pagamento parcial (valor
 * cheio em competência), cancelado, margem negativa e mesma categoria em
 * recebível e pagável (soma sem sinal — comportamento atual, ver relatório S-02).
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Category, Payable, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { controladoriaSkill, type DreData, type IndicatorsData } from "../index";

let seq = 0;

function seedCategory(env: TestEnv, over: Partial<Category>): Category {
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

function seedReceivable(env: TestEnv, over: Partial<Receivable>): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `recv_${++seq}`;
  const r: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: id,
    issueDate: "2026-07-10",
    dueDate: "2026-08-10",
    amountCents: 100_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.receivables.push(r);
  return r;
}

function seedPayable(env: TestEnv, over: Partial<Payable>): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const p: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: id,
    issueDate: "2026-07-10",
    dueDate: "2026-08-10",
    amountCents: 100_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(p);
  return p;
}

async function dre(env: TestEnv, period: string): Promise<DreData> {
  const res = await runSkill(controladoriaSkill, env.ctx(), { action: "dre", period });
  expect(res.data).not.toBeNull();
  return res.data as DreData;
}

describe("DRE — competência por data de emissão", () => {
  it("virada de ano: 31/12 entra em dezembro e 01/01 no ano seguinte", async () => {
    const env = createTestEnv();
    const vendas = seedCategory(env, { kind: "income", dreGroup: "receita_bruta" });
    seedReceivable(env, { categoryId: vendas.id, issueDate: "2026-12-31", dueDate: "2027-01-30", amountCents: 1_000 });
    seedReceivable(env, { categoryId: vendas.id, issueDate: "2027-01-01", dueDate: "2027-01-31", amountCents: 2_000 });
    expect((await dre(env, "2026-12")).dre.receitaBrutaCents).toBe(1_000);
    expect((await dre(env, "2027-01")).dre.receitaBrutaCents).toBe(2_000);
  });

  it("categoria INATIVA continua classificando pelo seu grupo (não vira 'outras')", async () => {
    const env = createTestEnv();
    const cmv = seedCategory(env, { dreGroup: "custos", active: false });
    seedPayable(env, { categoryId: cmv.id, amountCents: 300 });
    const d = await dre(env, "2026-07");
    expect(d.dre.custosCents).toBe(300);
    expect(d.dre.outrasCents).toBe(0);
  });

  it("pagamento parcial e vencido: competência usa o VALOR CHEIO do título, não o saldo nem o pago", async () => {
    const env = createTestEnv();
    const adm = seedCategory(env, { dreGroup: "despesas_operacionais" });
    seedPayable(env, { categoryId: adm.id, amountCents: 500, paidCents: 200, status: "partially_paid", dueDate: "2026-07-20" });
    expect((await dre(env, "2026-07")).dre.despesasOperacionaisCents).toBe(500);
  });

  it("cancelado fica fora mesmo com categoria e emissão no mês", async () => {
    const env = createTestEnv();
    const adm = seedCategory(env, { dreGroup: "despesas_operacionais" });
    seedPayable(env, { categoryId: adm.id, amountCents: 9_999, status: "canceled", canceledAt: env.clock.now().toISOString() });
    seedPayable(env, { categoryId: adm.id, amountCents: 1 });
    expect((await dre(env, "2026-07")).dre.despesasOperacionaisCents).toBe(1);
  });

  it("recebível e pagável na MESMA categoria somam sem sinal (comportamento atual — registrado no relatório como decisão pendente)", async () => {
    const env = createTestEnv();
    const cat = seedCategory(env, { dreGroup: "despesas_operacionais" });
    seedPayable(env, { categoryId: cat.id, amountCents: 100 });
    seedReceivable(env, { categoryId: cat.id, amountCents: 100 }); // um "estorno" lançado como recebível
    expect((await dre(env, "2026-07")).dre.despesasOperacionaisCents).toBe(200);
  });
});

describe("Indicadores — margens com resultado negativo e arredondamento", () => {
  it("custos acima da receita: margem bruta negativa com 2 casas (−50%), sem null", async () => {
    const env = createTestEnv();
    const vendas = seedCategory(env, { kind: "income", dreGroup: "receita_bruta" });
    const cmv = seedCategory(env, { dreGroup: "custos" });
    seedReceivable(env, { categoryId: vendas.id, amountCents: 1_000 });
    seedPayable(env, { categoryId: cmv.id, amountCents: 1_500 });
    const res = await runSkill(controladoriaSkill, env.ctx(), { action: "indicators", period: "2026-07" });
    const data = res.data as IndicatorsData;
    const margem = data.indicators.find((i) => i.key === "margem_bruta")!;
    expect(margem.valuePercent).toBe(-50);
    const ebitda = data.indicators.find((i) => i.key === "ebitda_gerencial")!;
    expect(ebitda.valueCents).toBe(-500);
  });

  it("percentual com dízima é arredondado a 2 casas na skill (1/3 → 33,33)", async () => {
    const env = createTestEnv();
    const vendas = seedCategory(env, { kind: "income", dreGroup: "receita_bruta" });
    const cmv = seedCategory(env, { dreGroup: "custos" });
    seedReceivable(env, { categoryId: vendas.id, amountCents: 300 });
    seedPayable(env, { categoryId: cmv.id, amountCents: 200 });
    const res = await runSkill(controladoriaSkill, env.ctx(), { action: "indicators", period: "2026-07" });
    const margem = (res.data as IndicatorsData).indicators.find((i) => i.key === "margem_bruta")!;
    expect(margem.valuePercent).toBe(33.33);
  });
});
