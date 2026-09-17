/**
 * Auditoria de fórmulas — Faturamento (FAT-03 percentual recebido da fatura).
 * Caso de arredondamento com dízima e pagamento parcial em duas parcelas.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Customer, Invoice, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { faturamentoSkill, type BillingStatusData, type InvoiceData } from "../index";

let seq = 0;

function seedCustomer(env: TestEnv): Customer {
  const now = env.clock.now().toISOString();
  const c: Customer = { id: "cus_1", companyId: env.company.id, name: "Cliente Gama S.A.", active: true, createdAt: now, updatedAt: now };
  env.db.customers.push(c);
  return c;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> & { invoiceId: string; amountCents: number }): Receivable {
  const now = env.clock.now().toISOString();
  const id = `rcv_${++seq}`;
  const r: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: id,
    issueDate: "2026-08-18",
    dueDate: "2026-09-17",
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

async function createIssued(env: TestEnv, totalCents: number): Promise<Invoice> {
  const res = await runSkill(faturamentoSkill, env.ctx(), {
    action: "create_invoice",
    customerId: "cus_1",
    description: "Venda",
    totalCents,
    issue: true,
  });
  return (res.data as InvoiceData).invoice;
}

describe("Faturamento — percentual recebido do ciclo", () => {
  it("30.000 de 90.000 em duas parcelas = 33,33% (2 casas), status parcialmente recebido", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const inv = await createIssued(env, 90_000);
    seedReceivable(env, { invoiceId: inv.id, amountCents: 45_000, receivedCents: 30_000, status: "partially_received" });
    seedReceivable(env, { invoiceId: inv.id, amountCents: 45_000 });

    const res = await runSkill(faturamentoSkill, env.ctx(), { action: "billing_status" });
    const item = (res.data as BillingStatusData).cycle.find((c) => c.invoiceId === inv.id)!;
    expect(item.receivedCents).toBe(30_000);
    expect(item.receivedPercent).toBe(33.33);
    expect(item.status).toBe("partially_received");
  });

  it("fatura sem nada recebido: 0% e status aberto", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const inv = await createIssued(env, 10_000);
    seedReceivable(env, { invoiceId: inv.id, amountCents: 10_000 });
    const item = ((await runSkill(faturamentoSkill, env.ctx(), { action: "billing_status" })).data as BillingStatusData).cycle[0];
    expect(item.receivedPercent).toBe(0);
    expect(item.status).toBe("open");
  });
});
