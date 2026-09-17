/**
 * Auditoria de fórmulas — Contas a pagar (CAP-12 list_due, CAP-13
 * forecast_disbursements). Casos que os testes principais não cobrem:
 * pagamento parcial (encargos sobre o saldo restante), cancelado e pago fora,
 * limite inclusivo de hoje + 7, e virada de ano na previsão semanal.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Payable, Supplier } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { contasAPagarSkill, type ForecastDisbursementsData, type ListDueData } from "../index";

let seq = 0;

function seedSupplier(env: TestEnv): Supplier {
  const now = env.clock.now().toISOString();
  const s: Supplier = {
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Alfa Ltda",
    document: "11.222.333/0001-44",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  env.db.suppliers.push(s);
  return s;
}

function seedPayable(env: TestEnv, over: Partial<Payable> & { dueDate: string; amountCents: number }): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const p: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: id,
    issueDate: "2026-06-01",
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

describe("Contas a pagar — list_due (vencimentos até hoje + 7)", () => {
  it("parcial vencido: encargos incidem sobre o SALDO restante; cancelado e pago ficam fora; hoje+7 entra e hoje+8 não", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    seedSupplier(env);
    const parcial = seedPayable(env, { dueDate: "2026-08-10", amountCents: 100_000, paidCents: 40_000, status: "partially_paid" }); // 8 dias
    seedPayable(env, { dueDate: "2026-08-18", amountCents: 5_000, status: "canceled", canceledAt: env.clock.now().toISOString() });
    seedPayable(env, { dueDate: "2026-08-18", amountCents: 5_000, paidCents: 5_000, status: "paid" });
    const limite = seedPayable(env, { dueDate: "2026-08-25", amountCents: 700 }); // hoje + 7
    seedPayable(env, { dueDate: "2026-08-26", amountCents: 800 }); // hoje + 8

    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "list_due" });
    const data = res.data as ListDueData;
    expect(data.period).toEqual({ start: "2026-08-18", end: "2026-08-25" });
    expect(data.due.map((d) => d.payableId).sort()).toEqual([limite.id, parcial.id].sort());

    const p = data.due.find((d) => d.payableId === parcial.id)!;
    // saldo 60.000; multa 2% = 1.200; juros 60.000 × 1% × 8 / 30 = 160
    expect(p.daysLate).toBe(8);
    expect(p.fineCents).toBe(1_200);
    expect(p.interestCents).toBe(160);
    expect(p.totalDueCents).toBe(61_360);
    expect(data.totalDueCents).toBe(61_360 + 700);
  });

  it("base vazia: lista vazia, total zero e sem alertas", async () => {
    const env = createTestEnv();
    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "list_due" });
    const data = res.data as ListDueData;
    expect(data.due).toEqual([]);
    expect(data.totalDueCents).toBe(0);
    expect(res.alerts).toEqual([]);
  });
});

describe("Contas a pagar — forecast_disbursements (semanas)", () => {
  it("virada de ano: semanas contadas a partir de hoje cruzam 31/12 sem perder títulos", async () => {
    const env = createTestEnv("2026-12-28T15:00:00Z"); // hoje = 2026-12-28
    seedSupplier(env);
    seedPayable(env, { dueDate: "2027-01-02", amountCents: 100 }); // 5 dias → semana 1
    seedPayable(env, { dueDate: "2027-01-05", amountCents: 1_000 }); // 8 dias → semana 2
    seedPayable(env, { dueDate: "2026-12-01", amountCents: 10_000 }); // vencido → semana 1 (hoje)
    seedPayable(env, { dueDate: "2027-02-15", amountCents: 100_000 }); // fora do horizonte de 30 dias

    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "forecast_disbursements", horizonDays: 30 });
    const data = res.data as ForecastDisbursementsData;
    expect(data.period).toEqual({ start: "2026-12-28", end: "2027-01-27" });
    expect(data.weekly[0]).toMatchObject({ weekStart: "2026-12-28", weekEnd: "2027-01-03", totalCents: 10_100, count: 2 });
    expect(data.weekly[1]).toMatchObject({ weekStart: "2027-01-04", totalCents: 1_000, count: 1 });
    expect(data.totalCents).toBe(11_100);
  });
});
