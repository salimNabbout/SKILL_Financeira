import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Category, Customer, Invoice, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  contasAReceberSkill,
  type CreateReceivableData,
  type IssueChargeData,
  type ListOverdueData,
  type ProjectionData,
  type RegisterReceiptData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.
const TODAY = "2026-08-18";

let seedSeq = 0;

function seedCustomer(env: TestEnv, over: Partial<Customer> = {}): Customer {
  const now = env.clock.now().toISOString();
  const customer: Customer = {
    id: "cus_1",
    companyId: env.company.id,
    name: "Cliente Beta Comércio Ltda",
    document: "98.765.432/0001-10",
    email: "financeiro@beta.com.br",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.customers.push(customer);
  return customer;
}

function seedIncomeCategory(env: TestEnv, over: Partial<Category> = {}): Category {
  const category: Category = {
    id: "cat_vendas",
    companyId: env.company.id,
    name: "Vendas de Mercadorias",
    kind: "income",
    dreGroup: "receita_bruta",
    active: true,
    ...over,
  };
  env.db.categories.push(category);
  return category;
}

function seedInvoice(env: TestEnv, over: Partial<Invoice> = {}): Invoice {
  const now = env.clock.now().toISOString();
  const invoice: Invoice = {
    id: `inv_seed_${++seedSeq}`,
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Fatura de venda semeada",
    totalCents: 90_000,
    issueDate: TODAY,
    status: "issued",
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.invoices.push(invoice);
  return invoice;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> = {}): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `rcv_seed_${++seedSeq}`;
  const receivable: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Título semeado",
    issueDate: "2026-08-01",
    dueDate: "2026-08-25",
    amountCents: 100_000,
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

function baseCreateInput(over: Record<string, unknown> = {}) {
  return {
    action: "create_receivable",
    customerId: "cus_1",
    description: "Mensalidade de agosto",
    issueDate: "2026-08-10",
    dueDate: "2026-09-10",
    amountCents: 100_000,
    ...over,
  };
}

describe("contas_a_receber / create_receivable", () => {
  it("cria título à vista com dados corretos, publica evento e audita", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const res = await runSkill(
      contasAReceberSkill,
      env.ctx(),
      baseCreateInput({ method: "pix", notes: "obs" })
    );

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    const data = res.data as CreateReceivableData;
    expect(data.receivables).toHaveLength(1);
    const r = data.receivables[0];
    expect(r.customerId).toBe("cus_1");
    expect(r.amountCents).toBe(100_000);
    expect(r.receivedCents).toBe(0);
    expect(r.status).toBe("open");
    expect(r.dueDate).toBe("2026-09-10");
    expect(r.method).toBe("pix");
    expect(r.installmentNumber).toBe(1);
    expect(r.installmentCount).toBe(1);
    expect(r.originKey).toMatch(/^cus_1:[0-9a-f]{12}:1\/1$/);
    expect(r.createdBy).toBe("usr_analyst");

    const events = env.db.events.filter((e) => e.type === "receivable.created");
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("contas_a_receber");
    expect(env.db.auditRecords.some((a) => a.action === "receivable.created" && a.entityId === r.id)).toBe(true);
  });

  it("divide parcelas somando exatamente o total e vence mês a mês", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const res = await runSkill(
      contasAReceberSkill,
      env.ctx(),
      baseCreateInput({ amountCents: 100_001, installmentCount: 3 })
    );

    const data = res.data as CreateReceivableData;
    expect(data.receivables).toHaveLength(3);
    // splitInstallments(100001, 3): resto distribuído nas primeiras parcelas.
    expect(data.receivables.map((r) => r.amountCents)).toEqual([33_334, 33_334, 33_333]);
    expect(data.receivables.reduce((acc, r) => acc + r.amountCents, 0)).toBe(100_001);
    expect(data.receivables.map((r) => r.dueDate)).toEqual([
      "2026-09-10",
      "2026-10-10",
      "2026-11-10",
    ]);
    expect(data.receivables[1].description).toContain("(parcela 2/3)");
    expect(data.receivables.map((r) => r.installmentNumber)).toEqual([1, 2, 3]);
  });

  it("é idempotente: repetir a mesma entrada não duplica títulos nem eventos", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const first = await runSkill(
      contasAReceberSkill,
      env.ctx(),
      baseCreateInput({ installmentCount: 2 })
    );
    const eventsAfterFirst = env.db.events.filter((e) => e.type === "receivable.created").length;

    const second = await runSkill(
      contasAReceberSkill,
      env.ctx(),
      baseCreateInput({ installmentCount: 2 })
    );

    const firstData = first.data as CreateReceivableData;
    const secondData = second.data as CreateReceivableData;
    expect(secondData.receivables.map((r) => r.id)).toEqual(firstData.receivables.map((r) => r.id));
    expect(env.db.receivables).toHaveLength(2);
    expect(env.db.events.filter((e) => e.type === "receivable.created")).toHaveLength(
      eventsAfterFirst
    );
    expect(second.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
  });

  it("valida cliente inexistente e cliente inativo", async () => {
    const env = createTestEnv();
    const missing = await runSkill(contasAReceberSkill, env.ctx(), baseCreateInput());
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("customer_not_found");

    seedCustomer(env, { active: false });
    const inactive = await runSkill(contasAReceberSkill, env.ctx(), baseCreateInput());
    expect(inactive.status).toBe("error");
    expect(inactive.alerts[0].code).toBe("customer_inactive");
  });

  it("sem categoria informada, aplica sugestão heurística sobre categorias de receita", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedIncomeCategory(env); // "Vendas de Mercadorias" casa com o padrão /venda/.
    // Categoria de despesa homônima NÃO pode ser candidata.
    env.db.categories.push({
      id: "cat_desp",
      companyId: env.company.id,
      name: "Vendas — comissões (despesa)",
      kind: "expense",
      dreGroup: "despesas_operacionais",
      active: true,
    });

    const res = await runSkill(
      contasAReceberSkill,
      env.ctx(),
      baseCreateInput({ description: "Venda de mercadorias — pedido 42" })
    );

    const data = res.data as CreateReceivableData;
    expect(data.receivables[0].categoryId).toBe("cat_vendas");
    expect(res.confidence).toBeLessThan(1.0);
    expect(res.assumptions.some((a) => a.includes('provedor "mock"'))).toBe(true);
  });

  it("sem categoria e sem correspondência heurística, cria pendência de classificação", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const res = await runSkill(contasAReceberSkill, env.ctx(), baseCreateInput());
    const data = res.data as CreateReceivableData;
    expect(data.receivables[0].categoryId).toBeUndefined();
    expect(res.pending_items.some((p) => p.code === "categoria_indefinida")).toBe(true);
  });
});

describe("contas_a_receber / create_from_invoice", () => {
  it("exige fatura existente e emitida", async () => {
    const env = createTestEnv();
    seedCustomer(env);

    const missing = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: "inv_nao_existe",
    });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("invoice_not_found");

    const draft = seedInvoice(env, { status: "draft", issueDate: undefined });
    const notIssued = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: draft.id,
    });
    expect(notIssued.status).toBe("error");
    expect(notIssued.alerts[0].code).toBe("invoice_not_issued");
  });

  it("sem parcelas: cria 1 parcela com vencimento hoje+30 e valor total, com suposição explícita", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = seedInvoice(env, { totalCents: 250_000 });

    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      method: "boleto",
    });

    expect(res.status).toBe("success");
    const data = res.data as CreateReceivableData;
    expect(data.receivables).toHaveLength(1);
    const r = data.receivables[0];
    expect(r.amountCents).toBe(250_000);
    expect(r.dueDate).toBe("2026-09-17"); // 2026-08-18 + 30 dias
    expect(r.invoiceId).toBe(invoice.id);
    expect(r.description).toBe(invoice.description);
    expect(r.method).toBe("boleto");
    expect(r.originKey).toBe(`inv:${invoice.id}:1/1`);
    expect(res.assumptions.some((a) => a.includes("hoje + 30 dias"))).toBe(true);
    expect(env.db.events.filter((e) => e.type === "receivable.created")).toHaveLength(1);
  });

  it("com parcelas: a soma deve bater com o total da fatura", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = seedInvoice(env, { totalCents: 100_000 });

    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments: [
        { dueDate: "2026-09-01", amountCents: 50_000 },
        { dueDate: "2026-10-01", amountCents: 40_000 },
      ],
    });

    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("installments_sum_mismatch");
    expect(env.db.receivables).toHaveLength(0);
  });

  it("com parcelas válidas cria os títulos e é idempotente (rodar 2x não duplica)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = seedInvoice(env, { totalCents: 100_000 });
    const installments = [
      { dueDate: "2026-09-01", amountCents: 60_000 },
      { dueDate: "2026-10-01", amountCents: 40_000 },
    ];

    const first = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments,
    });
    const firstData = first.data as CreateReceivableData;
    expect(firstData.receivables.map((r) => r.amountCents)).toEqual([60_000, 40_000]);
    expect(firstData.receivables.map((r) => r.originKey)).toEqual([
      `inv:${invoice.id}:1/2`,
      `inv:${invoice.id}:2/2`,
    ]);

    const second = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments,
    });
    const secondData = second.data as CreateReceivableData;
    expect(secondData.receivables.map((r) => r.id)).toEqual(firstData.receivables.map((r) => r.id));
    expect(env.db.receivables).toHaveLength(2);
    expect(env.db.events.filter((e) => e.type === "receivable.created")).toHaveLength(2);
    expect(second.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
  });

  it("[D3] rejeita refaturar a mesma fatura com plano de parcelas DIFERENTE (evita duplicar títulos)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = seedInvoice(env, { totalCents: 90_000 });

    // Primeiro faturamento: 2 parcelas.
    const first = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments: [
        { dueDate: "2026-09-01", amountCents: 50_000 },
        { dueDate: "2026-10-01", amountCents: 40_000 },
      ],
    });
    expect(first.status).toBe("success");
    expect(env.db.receivables).toHaveLength(2);
    const eventsAfterFirst = env.db.events.filter((e) => e.type === "receivable.created").length;

    // Reprocessa a MESMA fatura com 3 parcelas: chaves de origem mudam por
    // completo (inv:X:n/2 -> inv:X:n/3), então a idempotência por originKey
    // não detecta os títulos ativos pré-existentes. Deve REJEITAR.
    const second = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments: [
        { dueDate: "2026-09-01", amountCents: 30_000 },
        { dueDate: "2026-10-01", amountCents: 30_000 },
        { dueDate: "2026-11-01", amountCents: 30_000 },
      ],
    });

    expect(second.status).toBe("error");
    expect(second.alerts[0].code).toBe("validation_error");
    // Nada novo criado: seguem apenas os 2 títulos ativos originais.
    const active = env.db.receivables.filter((r) => r.status !== "canceled");
    expect(active).toHaveLength(2);
    expect(env.db.receivables).toHaveLength(2);
    expect(env.db.events.filter((e) => e.type === "receivable.created")).toHaveLength(
      eventsAfterFirst
    );
  });

  it("[D3] refaturar com o MESMO plano continua idempotente (reutiliza, não duplica)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const invoice = seedInvoice(env, { totalCents: 90_000 });
    const installments = [
      { dueDate: "2026-09-01", amountCents: 50_000 },
      { dueDate: "2026-10-01", amountCents: 40_000 },
    ];

    const first = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments,
    });
    const second = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "create_from_invoice",
      invoiceId: invoice.id,
      installments,
    });

    expect(second.status).toBe("success");
    expect((second.data as CreateReceivableData).receivables.map((r) => r.id)).toEqual(
      (first.data as CreateReceivableData).receivables.map((r) => r.id)
    );
    expect(env.db.receivables).toHaveLength(2);
    expect(second.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
  });
});

describe("contas_a_receber / list_overdue", () => {
  it("calcula dias de atraso, saldo e encargos exatos e publica um único evento com a lista", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    // 10 dias de atraso, saldo integral de R$ 1.000,00.
    const r1 = seedReceivable(env, { id: "rcv_a", dueDate: "2026-08-08", amountCents: 100_000 });
    // 30 dias de atraso, parcialmente recebido: saldo de R$ 300,00.
    const r2 = seedReceivable(env, {
      id: "rcv_b",
      dueDate: "2026-07-19",
      amountCents: 50_000,
      receivedCents: 20_000,
      status: "partially_received",
    });
    // Não vencido: fora da lista.
    seedReceivable(env, { id: "rcv_c", dueDate: "2026-08-25" });
    // Cancelado vencido: fora da lista.
    seedReceivable(env, { id: "rcv_d", dueDate: "2026-08-01", status: "canceled" });

    const res = await runSkill(contasAReceberSkill, env.ctx(), { action: "list_overdue" });
    const data = res.data as ListOverdueData;

    expect(data.count).toBe(2);
    expect(data.overdue.map((o) => o.receivable.id)).toEqual([r2.id, r1.id]); // mais antigo primeiro
    expect(data.totalOverdueCents).toBe(130_000);

    const o1 = data.overdue.find((o) => o.receivable.id === r1.id)!;
    expect(o1.daysLate).toBe(10);
    expect(o1.remainingCents).toBe(100_000);
    // multa 2% = 2000; juros 1% a.m. pró-rata: round(100000×0,01×10/30) = 333.
    expect(o1.lateFee.fineCents).toBe(2_000);
    expect(o1.lateFee.interestCents).toBe(333);
    expect(o1.lateFee.totalCents).toBe(102_333);

    const o2 = data.overdue.find((o) => o.receivable.id === r2.id)!;
    expect(o2.daysLate).toBe(30);
    expect(o2.remainingCents).toBe(30_000);
    expect(o2.lateFee.fineCents).toBe(600);
    expect(o2.lateFee.interestCents).toBe(300);
    expect(o2.lateFee.totalCents).toBe(30_900);

    const events = env.db.events.filter((e) => e.type === "receivable.overdue_detected");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { count: number; items: unknown[] };
    expect(payload.count).toBe(2);
    expect(payload.items).toHaveLength(2);

    // Alerta crítico persistido por título.
    const persisted = env.db.alerts.filter((a) => a.code === "receivable_overdue");
    expect(persisted).toHaveLength(2);
    expect(persisted.every((a) => a.severity === "critical" && a.status === "open")).toBe(true);
    expect(res.alerts.filter((a) => a.code === "receivable_overdue")).toHaveLength(2);
  });

  it("não duplica alertas abertos ao reexecutar (dedupe por code+entityId)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedReceivable(env, { dueDate: "2026-08-08" });

    await runSkill(contasAReceberSkill, env.ctx(), { action: "list_overdue" });
    await runSkill(contasAReceberSkill, env.ctx(), { action: "list_overdue" });

    expect(env.db.alerts.filter((a) => a.code === "receivable_overdue")).toHaveLength(1);
  });

  it("sem vencidos: lista vazia, nenhum evento e nenhum alerta", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedReceivable(env, { dueDate: TODAY }); // vence hoje: ainda não é atraso

    const res = await runSkill(contasAReceberSkill, env.ctx(), { action: "list_overdue" });
    const data = res.data as ListOverdueData;
    expect(res.status).toBe("success");
    expect(data.count).toBe(0);
    expect(data.totalOverdueCents).toBe(0);
    expect(env.db.events.filter((e) => e.type === "receivable.overdue_detected")).toHaveLength(0);
    expect(env.db.alerts).toHaveLength(0);
  });
});

describe("contas_a_receber / register_receipt", () => {
  it("baixa parcial e depois total, com valores e status exatos", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const r = seedReceivable(env, { amountCents: 100_000 });

    const partial = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: r.id,
      amountCents: 40_000,
      receivedDate: TODAY,
      method: "pix",
    });
    const partialData = partial.data as RegisterReceiptData;
    expect(partial.status).toBe("success");
    expect(partialData.receipt.amountCents).toBe(40_000);
    expect(partialData.receipt.registeredBy).toBe("usr_analyst");
    expect(partialData.receivable.receivedCents).toBe(40_000);
    expect(partialData.receivable.status).toBe("partially_received");
    expect(partialData.remainingCents).toBe(60_000);

    const total = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: r.id,
      amountCents: 60_000,
      receivedDate: "2026-08-19",
      method: "transfer",
    });
    const totalData = total.data as RegisterReceiptData;
    expect(totalData.receivable.status).toBe("received");
    expect(totalData.receivable.receivedCents).toBe(100_000);
    expect(totalData.remainingCents).toBe(0);

    expect(env.db.receipts).toHaveLength(2);
    const events = env.db.events.filter((e) => e.type === "receivable.received");
    expect(events).toHaveLength(2);
    expect(
      env.db.auditRecords.filter(
        (a) => a.action === "receivable.receipt_registered" && a.entityId === r.id
      )
    ).toHaveLength(2);
  });

  it("não permite exceder o saldo nem baixar título quitado/cancelado", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const r = seedReceivable(env, { amountCents: 50_000, receivedCents: 20_000, status: "partially_received" });

    const exceeds = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: r.id,
      amountCents: 40_000,
      receivedDate: TODAY,
      method: "pix",
    });
    expect(exceeds.status).toBe("error");
    expect(exceeds.alerts[0].code).toBe("receipt_exceeds_balance");
    expect(env.db.receipts).toHaveLength(0);

    const settled = seedReceivable(env, { amountCents: 10_000, receivedCents: 10_000, status: "received" });
    const alreadySettled = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: settled.id,
      amountCents: 1,
      receivedDate: TODAY,
      method: "pix",
    });
    expect(alreadySettled.status).toBe("error");
    expect(alreadySettled.alerts[0].code).toBe("receivable_already_settled");

    const canceled = seedReceivable(env, { status: "canceled" });
    const onCanceled = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: canceled.id,
      amountCents: 1,
      receivedDate: TODAY,
      method: "pix",
    });
    expect(onCanceled.status).toBe("error");
    expect(onCanceled.alerts[0].code).toBe("receivable_canceled");
  });

  it("[D6] aceita recebimento acima do saldo quando o excedente corresponde aos encargos (multa+juros)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    // R$ 100.000, 10 dias de atraso (venceu em 2026-08-08, recebido em 2026-08-18).
    const r = seedReceivable(env, {
      id: "rcv_encargos",
      amountCents: 10_000_000,
      dueDate: "2026-08-08",
    });
    // Política padrão: multa 2% = 200.000; juros 1% a.m. pró-rata: round(10.000.000×0,01×10/30) = 33.333.
    // Total com encargos = 10.233.333; excedente sobre o saldo = 233.333.
    const fineCents = 200_000;
    const interestCents = 33_333;
    const chargesCents = fineCents + interestCents; // 233.333
    const totalWithCharges = 10_000_000 + chargesCents;

    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: r.id,
      amountCents: totalWithCharges,
      receivedDate: TODAY,
      method: "pix",
    });

    expect(res.status).toBe("success");
    const data = res.data as RegisterReceiptData;
    // Principal baixado integralmente: título quitado, saldo zero.
    const updated = env.db.receivables.find((x) => x.id === r.id)!;
    expect(updated.receivedCents).toBe(10_000_000);
    expect(updated.status).toBe("received");
    expect(data.remainingCents).toBe(0);
    // Invariante: o principal aplicado ao título nunca excede o saldo.
    expect(updated.receivedCents).toBeLessThanOrEqual(updated.amountCents);
    // Excedente identificado como encargo (multa + juros).
    expect(data.chargesCents).toBe(chargesCents);
    expect(data.principalCents).toBe(10_000_000);
    // Comunicação explícita do encargo (assumption) e no payload do evento.
    expect(res.assumptions.join(" ").toLowerCase()).toContain("encargo");
    const ev = env.db.events.filter((e) => e.type === "receivable.received");
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { chargesCents?: number }).chargesCents).toBe(chargesCents);
  });

  it("[D6] recebimento acima do saldo que NÃO corresponde aos encargos continua sendo rejeitado", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const r = seedReceivable(env, {
      id: "rcv_excesso",
      amountCents: 10_000_000,
      dueDate: "2026-08-08",
    });
    // Excedente de 500.000 não bate com os encargos calculados (233.333).
    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: r.id,
      amountCents: 10_500_000,
      receivedDate: TODAY,
      method: "pix",
    });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("receipt_exceeds_balance");
    expect(env.db.receipts).toHaveLength(0);
    expect(env.db.receivables.find((x) => x.id === r.id)!.receivedCents).toBe(0);
  });

  it("valida conta bancária quando informada", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const r = seedReceivable(env);

    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "register_receipt",
      receivableId: r.id,
      amountCents: 10_000,
      receivedDate: TODAY,
      method: "pix",
      bankAccountId: "ba_inexistente",
    });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("bank_account_not_found");
  });
});

describe("contas_a_receber / projection", () => {
  it("agrupa entradas previstas por semana com valores exatos (horizonte padrão 30 dias)", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedReceivable(env, { dueDate: "2026-08-20", amountCents: 100_000 }); // semana 1
    seedReceivable(env, {
      dueDate: "2026-08-30",
      amountCents: 50_000,
      receivedCents: 10_000,
      status: "partially_received",
    }); // semana 2, saldo 40.000
    seedReceivable(env, { dueDate: "2026-08-10", amountCents: 999_999 }); // vencido: fora
    seedReceivable(env, { dueDate: "2026-10-01", amountCents: 777_777 }); // além do horizonte: fora

    const res = await runSkill(contasAReceberSkill, env.ctx(), { action: "projection" });
    const data = res.data as ProjectionData;

    expect(data.horizonDays).toBe(30);
    expect(data.period).toEqual({ start: TODAY, end: "2026-09-17" });
    expect(data.weekly).toHaveLength(5);
    expect(data.weekly[0]).toMatchObject({
      weekStart: "2026-08-18",
      weekEnd: "2026-08-24",
      expectedCents: 100_000,
      count: 1,
    });
    expect(data.weekly[1]).toMatchObject({
      weekStart: "2026-08-25",
      weekEnd: "2026-08-31",
      expectedCents: 40_000,
      count: 1,
    });
    expect(data.weekly[4].weekEnd).toBe("2026-09-17");
    expect(data.totalCents).toBe(140_000);
    expect(data.formula).toContain("Σ");
    // Estimativa (assume recebimento no vencimento) → confiança < 1.
    expect(res.confidence).toBeLessThan(1.0);
    expect(res.assumptions.length).toBeGreaterThan(0);
  });

  it("aceita horizonte customizado", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedReceivable(env, { dueDate: "2026-08-20", amountCents: 30_000 });

    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "projection",
      horizonDays: 7,
    });
    const data = res.data as ProjectionData;
    expect(data.horizonDays).toBe(7);
    expect(data.weekly).toHaveLength(1);
    expect(data.totalCents).toBe(30_000);
  });
});

describe("contas_a_receber / validação de entrada", () => {
  it("rejeita ação desconhecida e datas fora do formato ISO", async () => {
    const env = createTestEnv();
    const bad = await runSkill(contasAReceberSkill, env.ctx(), { action: "explodir" });
    expect(bad.status).toBe("error");
    expect(bad.alerts[0].code).toBe("invalid_input");

    const badDate = await runSkill(
      contasAReceberSkill,
      env.ctx(),
      baseCreateInput({ dueDate: "10/09/2026" })
    );
    expect(badDate.status).toBe("error");
    expect(badDate.alerts[0].code).toBe("invalid_input");
  });
});

describe("contas_a_receber / issue_charge", () => {
  it("gera código pix determinístico pelo saldo em aberto, anota no título, audita e publica evento", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    const receivable = seedReceivable(env, {
      id: "rcv_chg",
      amountCents: 100_000,
      receivedCents: 40_000,
      status: "partially_received",
    });

    const res = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "issue_charge",
      receivableId: receivable.id,
      kind: "pix",
    });

    expect(res.status).toBe("success");
    const data = res.data as IssueChargeData;
    expect(data.charge.provider).toBe("mock");
    expect(data.charge.kind).toBe("pix");
    // Cobrança sempre pelo SALDO em aberto, não pelo valor de face.
    expect(data.remainingCents).toBe(60_000);
    expect(data.charge.code).toContain("MOCK");
    expect(data.receivable.notes).toContain(data.charge.chargeId);
    // Mock claramente identificado.
    expect(res.assumptions.join(" ").toLowerCase()).toContain("mock");

    expect(env.db.auditRecords.some((a) => a.action === "receivable.charge_issued")).toBe(true);
    const events = env.db.events.filter((e) => e.type === "receivable.updated");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ chargeId: data.charge.chargeId, kind: "pix" });
  });

  it("reemitir é idempotente: mesmo chargeId, anotação única, sem novo evento", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedReceivable(env, { id: "rcv_chg2", amountCents: 50_000 });
    const input = { action: "issue_charge", receivableId: "rcv_chg2", kind: "boleto" };

    const first = await runSkill(contasAReceberSkill, env.ctx(), input);
    const second = await runSkill(contasAReceberSkill, env.ctx(), input);

    const a = first.data as IssueChargeData;
    const b = second.data as IssueChargeData;
    expect(b.charge.chargeId).toBe(a.charge.chargeId);
    expect(b.charge.code).toMatch(/^\d{47}$/); // linha digitável fake do boleto
    const occurrences = (b.receivable.notes ?? "").split(a.charge.chargeId).length - 1;
    expect(occurrences).toBe(1);
    expect(env.db.events.filter((e) => e.type === "receivable.updated")).toHaveLength(1);
    expect(second.assumptions.join(" ")).toContain("idempotente");
  });

  it("rejeita título sem saldo em aberto ou inexistente", async () => {
    const env = createTestEnv();
    seedCustomer(env);
    seedReceivable(env, { id: "rcv_done", amountCents: 30_000, receivedCents: 30_000, status: "received" });

    const settled = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "issue_charge",
      receivableId: "rcv_done",
      kind: "pix",
    });
    expect(settled.status).toBe("error");
    expect(settled.alerts[0].code).toBe("invalid_state");

    const missing = await runSkill(contasAReceberSkill, env.ctx(), {
      action: "issue_charge",
      receivableId: "rcv_404",
      kind: "pix",
    });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("not_found");
  });
});
