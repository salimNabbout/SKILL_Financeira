import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Customer, Invoice, Receipt, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  faturamentoSkill,
  type BillingStatusData,
  type CancelInvoiceData,
  type InvoiceData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.
const TODAY = "2026-08-18";

let seedSeq = 0;

function seedCustomer(env: TestEnv, over: Partial<Customer> = {}): Customer {
  const now = env.clock.now().toISOString();
  const customer: Customer = {
    id: "cus_1",
    companyId: env.company.id,
    name: "Cliente Gama S.A.",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.customers.push(customer);
  return customer;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> = {}): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `rcv_seed_${++seedSeq}`;
  const receivable: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Título semeado",
    issueDate: TODAY,
    dueDate: "2026-09-17",
    amountCents: 50_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}:1/1`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.receivables.push(receivable);
  return receivable;
}

function seedReceipt(env: TestEnv, over: Partial<Receipt> = {}): Receipt {
  const receipt: Receipt = {
    id: `rcp_seed_${++seedSeq}`,
    companyId: env.company.id,
    receivableId: "rcv_seed_1",
    amountCents: 10_000,
    receivedDate: TODAY,
    method: "pix",
    registeredBy: "usr_analyst",
    createdAt: env.clock.now().toISOString(),
    ...over,
  };
  env.db.receipts.push(receipt);
  return receipt;
}

function baseCreateInput(over: Record<string, unknown> = {}) {
  return {
    action: "create_invoice",
    customerId: "cus_1",
    description: "Venda de serviços de consultoria",
    totalCents: 100_000,
    ...over,
  };
}

async function createIssued(env: TestEnv, over: Record<string, unknown> = {}): Promise<Invoice> {
  const res = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput({ issue: true, ...over }));
  return (res.data as InvoiceData).invoice;
}

describe("faturamento / create_invoice", () => {
  it("cria fatura draft por padrão (sem NF-e) e publica invoice.created", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const res = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput({ saleRef: "PED-1" }));

    expect(res.status).toBe("success");
    const { invoice } = res.data as InvoiceData;
    expect(invoice.status).toBe("draft");
    expect(invoice.totalCents).toBe(100_000);
    expect(invoice.saleRef).toBe("PED-1");
    expect(invoice.issueDate).toBeUndefined();
    expect(invoice.nfeMock).toBeUndefined();
    expect(env.db.events.filter((e) => e.type === "invoice.created")).toHaveLength(1);
    expect(env.db.events.filter((e) => e.type === "invoice.issued")).toHaveLength(0);
    expect(env.db.auditRecords.some((a) => a.action === "invoice.created" && a.entityId === invoice.id)).toBe(true);
  });

  it("com issue: true emite NF-e MOCK (número sequencial, chave de 44 dígitos, provider mock)", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const res = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput({ issue: true }));

    const { invoice } = res.data as InvoiceData;
    expect(invoice.status).toBe("issued");
    expect(invoice.issueDate).toBe(TODAY);
    expect(invoice.nfeMock).toBeDefined();
    expect(invoice.nfeMock!.number).toBe("NFE-1");
    expect(invoice.nfeMock!.accessKey).toMatch(/^\d{44}$/);
    expect(invoice.nfeMock!.provider).toBe("mock");
    expect(invoice.nfeMock!.issuedAt).toBe(env.clock.now().toISOString());
    expect(res.assumptions.some((a) => a.includes("mock") && a.includes("SIMULADA"))).toBe(true);
    expect(env.db.events.filter((e) => e.type === "invoice.created")).toHaveLength(1);
    expect(env.db.events.filter((e) => e.type === "invoice.issued")).toHaveLength(1);

    // Chave determinística por empresa+fatura; faturas distintas têm chaves distintas.
    const second = await createIssued(env, { description: "Outra venda" });
    expect(second.nfeMock!.number).toBe("NFE-2");
    expect(second.nfeMock!.accessKey).not.toBe(invoice.nfeMock!.accessKey);
  });

  it("é idempotente por saleRef: mesma referência não duplica fatura", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const first = await runSkill(
      faturamentoSkill,
      env.ctx(),
      baseCreateInput({ saleRef: "PED-77", issue: true })
    );
    const firstInvoice = (first.data as InvoiceData).invoice;

    const second = await runSkill(
      faturamentoSkill,
      env.ctx(),
      baseCreateInput({ saleRef: "PED-77", issue: true })
    );
    const secondInvoice = (second.data as InvoiceData).invoice;

    expect(secondInvoice.id).toBe(firstInvoice.id);
    expect(env.db.invoices).toHaveLength(1);
    expect(second.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
    // Já emitida: não re-emite.
    expect(env.db.events.filter((e) => e.type === "invoice.issued")).toHaveLength(1);
  });

  it("saleRef repetido com issue emite a draft existente em vez de duplicar", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    await runSkill(faturamentoSkill, env.ctx(), baseCreateInput({ saleRef: "PED-88" }));
    const second = await runSkill(
      faturamentoSkill,
      env.ctx(),
      baseCreateInput({ saleRef: "PED-88", issue: true })
    );

    const invoice = (second.data as InvoiceData).invoice;
    expect(invoice.status).toBe("issued");
    expect(env.db.invoices).toHaveLength(1);
  });

  it("fatura cancelada não bloqueia nova fatura com o mesmo saleRef", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const first = await createIssued(env, { saleRef: "PED-99" });
    await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: first.id,
      reason: "Venda desfeita",
    });

    const res = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput({ saleRef: "PED-99" }));
    const invoice = (res.data as InvoiceData).invoice;
    expect(invoice.id).not.toBe(first.id);
    expect(env.db.invoices).toHaveLength(2);
  });

  it("valida cliente inexistente e inativo", async () => {
    const env = createTestEnv();
    const missing = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput());
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("customer_not_found");

    seedCustomer(env, { active: false });
    const inactive = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput());
    expect(inactive.status).toBe("error");
    expect(inactive.alerts[0].code).toBe("customer_inactive");
  });
});

describe("faturamento / issue_invoice", () => {
  it("emite uma draft e é idempotente quando já emitida", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const created = await runSkill(faturamentoSkill, env.ctx(), baseCreateInput());
    const draft = (created.data as InvoiceData).invoice;

    const issued = await runSkill(faturamentoSkill, env.ctx(), {
      action: "issue_invoice",
      invoiceId: draft.id,
    });
    const invoice = (issued.data as InvoiceData).invoice;
    expect(invoice.status).toBe("issued");
    expect(invoice.nfeMock!.number).toBe("NFE-1");

    const again = await runSkill(faturamentoSkill, env.ctx(), {
      action: "issue_invoice",
      invoiceId: draft.id,
    });
    const sameInvoice = (again.data as InvoiceData).invoice;
    expect(sameInvoice.nfeMock!.number).toBe("NFE-1");
    expect(again.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
    expect(env.db.events.filter((e) => e.type === "invoice.issued")).toHaveLength(1);
  });

  it("não emite fatura cancelada nem inexistente", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = await createIssued(env);
    await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: invoice.id,
      reason: "Erro de digitação",
    });

    const onCanceled = await runSkill(faturamentoSkill, env.ctx(), {
      action: "issue_invoice",
      invoiceId: invoice.id,
    });
    expect(onCanceled.status).toBe("error");
    expect(onCanceled.alerts[0].code).toBe("invoice_canceled");

    const missing = await runSkill(faturamentoSkill, env.ctx(), {
      action: "issue_invoice",
      invoiceId: "inv_nao_existe",
    });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("invoice_not_found");
  });
});

describe("faturamento / cancel_invoice", () => {
  it("cancela fatura emitida e os títulos abertos vinculados, com auditoria e evento", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = await createIssued(env);
    const r1 = seedReceivable(env, { invoiceId: invoice.id });
    const r2 = seedReceivable(env, { invoiceId: invoice.id });
    seedReceivable(env); // título de outra origem: intocado

    const res = await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: invoice.id,
      reason: "Cliente desistiu da compra",
    });

    expect(res.status).toBe("success");
    const data = res.data as CancelInvoiceData;
    expect(data.invoice.status).toBe("canceled");
    expect(data.canceledReceivables.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(data.canceledReceivables.every((r) => r.status === "canceled" && r.canceledAt)).toBe(true);
    expect(env.db.receivables.filter((r) => r.status === "canceled")).toHaveLength(2);

    const events = env.db.events.filter((e) => e.type === "invoice.canceled");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { reason: string; canceledReceivableIds: string[] };
    expect(payload.reason).toBe("Cliente desistiu da compra");
    expect(payload.canceledReceivableIds.sort()).toEqual([r1.id, r2.id].sort());
    expect(
      env.db.auditRecords.filter((a) => a.action === "receivable.canceled")
    ).toHaveLength(2);
    expect(
      env.db.auditRecords.some((a) => a.action === "invoice.canceled" && a.entityId === invoice.id)
    ).toBe(true);
  });

  it("não cancela fatura com recebimento registrado em algum título", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = await createIssued(env);
    const r = seedReceivable(env, {
      invoiceId: invoice.id,
      receivedCents: 10_000,
      status: "partially_received",
    });
    seedReceipt(env, { receivableId: r.id, amountCents: 10_000 });

    const res = await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: invoice.id,
      reason: "Tentativa inválida",
    });

    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("invoice_has_receipts");
    expect(env.db.invoices[0].status).toBe("issued");
    expect(env.db.receivables[0].status).toBe("partially_received");
  });

  it("é idempotente para fatura já cancelada e valida inexistente", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = await createIssued(env);
    await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: invoice.id,
      reason: "Primeiro cancelamento",
    });

    const again = await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: invoice.id,
      reason: "Repetido",
    });
    expect(again.status).toBe("success");
    expect((again.data as CancelInvoiceData).canceledReceivables).toHaveLength(0);
    expect(again.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
    expect(env.db.events.filter((e) => e.type === "invoice.canceled")).toHaveLength(1);

    const missing = await runSkill(faturamentoSkill, env.ctx(), {
      action: "cancel_invoice",
      invoiceId: "inv_nao_existe",
      reason: "x",
    });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("invoice_not_found");
  });
});

describe("faturamento / billing_status", () => {
  it("classifica drafts, emitidas sem títulos e ciclo com percentual recebido exato", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    // Draft: venda registrada não faturada.
    const draftRes = await runSkill(
      faturamentoSkill,
      env.ctx(),
      baseCreateInput({ description: "Venda ainda não faturada", totalCents: 80_000 })
    );
    const draft = (draftRes.data as InvoiceData).invoice;

    // Emitida sem títulos: inconsistência.
    const unbilled = await createIssued(env, { description: "Emitida sem títulos", totalCents: 60_000 });

    // Emitida com títulos parcialmente recebidos: 25.000 de 100.000 = 25%.
    const billed = await createIssued(env, { description: "Emitida com títulos", totalCents: 100_000 });
    seedReceivable(env, { invoiceId: billed.id, amountCents: 60_000, receivedCents: 25_000, status: "partially_received" });
    seedReceivable(env, { invoiceId: billed.id, amountCents: 40_000 });

    const res = await runSkill(faturamentoSkill, env.ctx(), { action: "billing_status" });
    const data = res.data as BillingStatusData;

    expect(data.drafts).toHaveLength(1);
    expect(data.drafts[0].invoiceId).toBe(draft.id);
    expect(res.pending_items).toHaveLength(1);
    expect(res.pending_items[0]).toMatchObject({ code: "venda_nao_faturada", entityId: draft.id });

    expect(data.issuedUnbilled).toHaveLength(1);
    expect(data.issuedUnbilled[0].invoiceId).toBe(unbilled.id);
    expect(res.alerts.some((a) => a.code === "invoice_sem_titulos" && a.entityId === unbilled.id)).toBe(true);
    expect(res.status).toBe("warning"); // alerta de severidade warning no envelope
    expect(env.db.alerts.filter((a) => a.code === "invoice_sem_titulos")).toHaveLength(1);

    expect(data.cycle).toHaveLength(1);
    expect(data.cycle[0]).toMatchObject({
      invoiceId: billed.id,
      totalCents: 100_000,
      receivedCents: 25_000,
      receivablesCount: 2,
      status: "partially_received",
      receivedPercent: 25,
    });
    expect(data.period.asOf).toBe(TODAY);
  });

  it("não duplica alerta de inconsistência ao reexecutar e reconhece fatura quitada", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    await createIssued(env, { description: "Sem títulos", totalCents: 60_000 });
    const settled = await createIssued(env, { description: "Quitada", totalCents: 30_000 });
    seedReceivable(env, {
      invoiceId: settled.id,
      amountCents: 30_000,
      receivedCents: 30_000,
      status: "received",
    });

    const first = await runSkill(faturamentoSkill, env.ctx(), { action: "billing_status" });
    const second = await runSkill(faturamentoSkill, env.ctx(), { action: "billing_status" });

    expect(env.db.alerts.filter((a) => a.code === "invoice_sem_titulos")).toHaveLength(1);
    const firstData = first.data as BillingStatusData;
    const secondData = second.data as BillingStatusData;
    expect(firstData.cycle[0].status).toBe("received");
    expect(firstData.cycle[0].receivedPercent).toBe(100);
    expect(secondData.cycle[0].status).toBe("received");
  });

  it("títulos cancelados não contam no ciclo (fatura volta a constar como sem títulos)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = await createIssued(env);
    seedReceivable(env, { invoiceId: invoice.id, status: "canceled" });

    const res = await runSkill(faturamentoSkill, env.ctx(), { action: "billing_status" });
    const data = res.data as BillingStatusData;
    expect(data.cycle).toHaveLength(0);
    expect(data.issuedUnbilled.map((i) => i.invoiceId)).toEqual([invoice.id]);
  });
});

describe("faturamento / validação de entrada", () => {
  it("rejeita ação desconhecida e valores não inteiros/negativos", async () => {
    const env = createTestEnv();
    const bad = await runSkill(faturamentoSkill, env.ctx(), { action: "explodir" });
    expect(bad.status).toBe("error");
    expect(bad.alerts[0].code).toBe("invalid_input");

    const badTotal = await runSkill(
      faturamentoSkill,
      env.ctx(),
      baseCreateInput({ totalCents: -5 })
    );
    expect(badTotal.status).toBe("error");
    expect(badTotal.alerts[0].code).toBe("invalid_input");
  });
});
