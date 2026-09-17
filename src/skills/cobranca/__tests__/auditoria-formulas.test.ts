/**
 * Auditoria de fórmulas — Cobrança (COB-01..05 indicadores de inadimplência).
 * Fronteiras exatas das faixas de aging (7/8, 30/31, 60/61 dias), janela do
 * DSO (91 dias inclusivos: hoje−90 … hoje) com recibo estornado fora, título
 * cancelado fora da carteira e base vazia.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Receipt, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { cobrancaSkill, type DelinquencyIndicatorsData } from "../index";

let seq = 0;

function seedReceivable(env: TestEnv, over: Partial<Receivable> & { dueDate: string; amountCents: number }): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `rcv_${++seq}`;
  const r: Receivable = {
    id,
    companyId: env.company.id,
    customerId: `cli_${seq}`,
    description: id,
    issueDate: "2026-05-01",
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

function seedReceipt(env: TestEnv, amountCents: number, receivedDate: string, status?: "registered" | "canceled"): Receipt {
  const r: Receipt = {
    id: `rcp_${++seq}`,
    companyId: env.company.id,
    receivableId: "rcv_x",
    amountCents,
    receivedDate,
    method: "pix",
    status,
    registeredBy: "usr_analyst",
    createdAt: env.clock.now().toISOString(),
  };
  env.db.receipts.push(r);
  return r;
}

async function indicators(env: TestEnv): Promise<DelinquencyIndicatorsData["indicators"]> {
  const res = await runSkill(cobrancaSkill, env.ctx(env.actorFor("analyst")), { action: "delinquency_indicators" });
  expect(res.data).not.toBeNull();
  return (res.data as DelinquencyIndicatorsData).indicators;
}

describe("Cobrança — aging por faixa (fronteiras exatas)", () => {
  it("7 dias → 1-7; 8 → 8-30; 30 → 8-30; 31 → 31-60; 60 → 31-60; 61 → 60+ (rótulo '60+' começa em 61)", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    seedReceivable(env, { dueDate: "2026-08-11", amountCents: 1 }); // 7
    seedReceivable(env, { dueDate: "2026-08-10", amountCents: 10 }); // 8
    seedReceivable(env, { dueDate: "2026-07-19", amountCents: 100 }); // 30
    seedReceivable(env, { dueDate: "2026-07-18", amountCents: 1_000 }); // 31
    seedReceivable(env, { dueDate: "2026-06-19", amountCents: 10_000 }); // 60
    seedReceivable(env, { dueDate: "2026-06-18", amountCents: 100_000 }); // 61
    seedReceivable(env, { dueDate: "2026-08-18", amountCents: 1_000_000 }); // vence hoje: NÃO é vencido
    const ind = await indicators(env);
    expect(ind.agingCents.value).toEqual({ "1-7": 1, "8-30": 110, "31-60": 11_000, "60+": 100_000 });
    // carteira aberta = 1.111.111; vencido = 111.111 → 10,00%
    expect(ind.delinquencyRatePercent.value).toBe(10);
    expect(ind.delinquentCustomerCount.value).toBe(6);
  });

  it("cancelado vencido fica fora da carteira e do vencido; parcial entra pelo saldo; ticket médio é half-up", async () => {
    const env = createTestEnv();
    seedReceivable(env, { dueDate: "2026-08-01", amountCents: 9_999, status: "canceled" });
    seedReceivable(env, { dueDate: "2026-08-01", amountCents: 1_000, receivedCents: 999, status: "partially_received" }); // saldo 1
    seedReceivable(env, { dueDate: "2026-08-01", amountCents: 2 }); // saldo 2
    const ind = await indicators(env);
    expect(ind.agingCents.value["8-30"]).toBe(3);
    expect(ind.averageOverdueTicketCents.value).toBe(2); // 3 / 2 = 1,5 → 2
    expect(ind.delinquencyRatePercent.value).toBe(100);
  });
});

describe("Cobrança — DSO", () => {
  it("janela de recebimentos vai de hoje−90 a hoje (inclusivo); recibo estornado fica fora", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18; hoje−90 = 2026-05-20
    seedReceivable(env, { dueDate: "2026-09-30", amountCents: 90_000 }); // carteira aberta, não vencida
    seedReceipt(env, 30_000, "2026-05-20"); // primeiro dia da janela: entra
    seedReceipt(env, 999_999, "2026-05-19"); // fora
    seedReceipt(env, 999_999, "2026-07-01", "canceled"); // estornado: fora
    seedReceipt(env, 60_000, "2026-07-15");
    const ind = await indicators(env);
    // 90.000 / 90.000 × 90 = 90 dias
    expect(ind.dsoDays.value).toBe(90);
    expect(ind.delinquencyRatePercent.value).toBe(0);
    expect(ind.averageOverdueTicketCents.value).toBeNull();
  });

  it("base vazia: taxa, ticket e DSO nulos; aging zerado; zero clientes", async () => {
    const env = createTestEnv();
    const ind = await indicators(env);
    expect(ind.delinquencyRatePercent.value).toBeNull();
    expect(ind.averageOverdueTicketCents.value).toBeNull();
    expect(ind.dsoDays.value).toBeNull();
    expect(ind.delinquentCustomerCount.value).toBe(0);
    expect(ind.agingCents.value).toEqual({ "1-7": 0, "8-30": 0, "31-60": 0, "60+": 0 });
  });
});
