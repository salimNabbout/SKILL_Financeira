import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type {
  Category,
  ChartAccountType,
  Customer,
  Payable,
  Payment,
  Receipt,
  Receivable,
  Supplier,
} from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  contabilSkill,
  type CheckMasterDataData,
  type ExportBatchData,
  type PrepareEntriesData,
  type TaxSummaryData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.

let seq = 0;
const nextId = (prefix: string) => `${prefix}_seed_${++seq}`;

function seedChart(env: TestEnv): void {
  const chart: Array<[string, string, ChartAccountType]> = [
    ["1.1", "Caixa e bancos", "asset"],
    ["2.2", "Obrigações fiscais", "liability"],
    ["3.1", "Receita de vendas", "revenue"],
    ["4.1", "Custos de mercadorias", "expense"],
    ["4.2", "Despesas operacionais", "expense"],
    ["4.3", "Despesas financeiras", "expense"],
  ];
  for (const [code, name, type] of chart) {
    env.db.chartAccounts.push({
      id: `coa_${code.replace(/\./g, "_")}`,
      companyId: env.company.id,
      code,
      name,
      type,
      active: true,
    });
  }
}

function seedSupplier(env: TestEnv, over: Partial<Supplier> = {}): Supplier {
  const now = env.clock.now().toISOString();
  const supplier: Supplier = {
    id: nextId("sup"),
    companyId: env.company.id,
    name: "Fornecedora Alfa Ltda",
    document: "11.222.333/0001-44",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.suppliers.push(supplier);
  return supplier;
}

function seedCustomer(env: TestEnv, over: Partial<Customer> = {}): Customer {
  const now = env.clock.now().toISOString();
  const customer: Customer = {
    id: nextId("cus"),
    companyId: env.company.id,
    name: "Cliente Beta ME",
    document: "99.888.777/0001-66",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.customers.push(customer);
  return customer;
}

function seedCategory(env: TestEnv, over: Partial<Category> = {}): Category {
  const category: Category = {
    id: nextId("cat"),
    companyId: env.company.id,
    name: "Despesas gerais",
    kind: "expense",
    dreGroup: "despesas_operacionais",
    active: true,
    ...over,
  };
  env.db.categories.push(category);
  return category;
}

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? nextId("payb");
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_x",
    description: "Serviço de manutenção",
    issueDate: "2026-08-01",
    dueDate: "2026-08-15",
    amountCents: 123_456,
    paidCents: 0,
    currency: "BRL",
    status: "paid",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(payable);
  return payable;
}

function seedPayment(env: TestEnv, over: Partial<Payment> = {}): Payment {
  const now = env.clock.now().toISOString();
  const payment: Payment = {
    id: nextId("pay"),
    companyId: env.company.id,
    payableId: "payb_x",
    bankAccountId: "ba_1",
    amountCents: 123_456,
    scheduledDate: "2026-08-15",
    executedAt: "2026-08-15T12:00:00Z",
    status: "executed",
    approvalId: "apr_x",
    requestedBy: "usr_analyst",
    executedBy: "usr_approver",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payments.push(payment);
  return payment;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> = {}): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? nextId("recv");
  const receivable: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_x",
    description: "Venda de mercadorias",
    issueDate: "2026-08-05",
    dueDate: "2026-08-10",
    amountCents: 200_000,
    receivedCents: 200_000,
    currency: "BRL",
    status: "received",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}`,
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
    id: nextId("rec"),
    companyId: env.company.id,
    receivableId: "recv_x",
    amountCents: 200_000,
    receivedDate: "2026-08-10",
    method: "pix",
    registeredBy: "usr_analyst",
    createdAt: env.clock.now().toISOString(),
    ...over,
  };
  env.db.receipts.push(receipt);
  return receipt;
}

/** Cenário base: pagamento executado classificado em despesas_operacionais. */
function seedExecutedPaymentScenario(env: TestEnv) {
  seedChart(env);
  const supplier = seedSupplier(env);
  const category = seedCategory(env, { dreGroup: "despesas_operacionais" });
  const payable = seedPayable(env, { supplierId: supplier.id, categoryId: category.id });
  const payment = seedPayment(env, { payableId: payable.id });
  return { supplier, category, payable, payment };
}

describe("integracao_contabil_fiscal — prepare_entries", () => {
  it("gera partida dobrada correta para pagamento executado (débito 4.2, crédito 1.1)", async () => {
    const env = createTestEnv();
    const { payment, supplier } = seedExecutedPaymentScenario(env);

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payment.id,
    });

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    const data = res.data as PrepareEntriesData;
    expect(data.entries).toHaveLength(1);
    const entry = data.entries[0];
    expect(entry.debitAccount).toBe("4.2");
    expect(entry.creditAccount).toBe("1.1");
    expect(entry.amountCents).toBe(123_456);
    // executedAt 2026-08-15T12:00:00Z → data de negócio 2026-08-15 em São Paulo.
    expect(entry.entryDate).toBe("2026-08-15");
    expect(entry.sourceType).toBe("payment");
    expect(entry.sourceId).toBe(payment.id);
    expect(entry.memo).toContain(supplier.name);
    expect(entry.exported).toBe(false);
    // Sem categoria faltante → nenhum pending_item, e assumption do contador sempre presente.
    expect(res.pending_items).toHaveLength(0);
    expect(res.assumptions.some((a) => a.includes("não substitui o contador"))).toBe(true);
    // Evento publicado e persistido.
    const events = env.db.events.filter((e) => e.type === "accounting.entry_prepared");
    expect(events).toHaveLength(1);
  });

  it("mapeia dreGroup custos→4.1, despesas_financeiras→4.3 e deducoes→2.2", async () => {
    const env = createTestEnv();
    seedChart(env);
    const supplier = seedSupplier(env);
    const cases: Array<[Category["dreGroup"], string]> = [
      ["custos", "4.1"],
      ["despesas_financeiras", "4.3"],
      ["deducoes", "2.2"],
    ];
    for (const [dreGroup, expectedDebit] of cases) {
      const category = seedCategory(env, { dreGroup });
      const payable = seedPayable(env, { supplierId: supplier.id, categoryId: category.id });
      const payment = seedPayment(env, { payableId: payable.id });
      const res = await runSkill(contabilSkill, env.ctx(), {
        action: "prepare_entries",
        sourceType: "payment",
        sourceId: payment.id,
      });
      const data = res.data as PrepareEntriesData;
      expect(data.entries[0].debitAccount).toBe(expectedDebit);
      expect(data.entries[0].creditAccount).toBe("1.1");
    }
  });

  it("gera partida dobrada correta para recebimento (débito 1.1, crédito 3.1)", async () => {
    const env = createTestEnv();
    seedChart(env);
    const customer = seedCustomer(env);
    const category = seedCategory(env, { kind: "income", dreGroup: "receita_bruta" });
    const receivable = seedReceivable(env, { customerId: customer.id, categoryId: category.id });
    const receipt = seedReceipt(env, { receivableId: receivable.id, amountCents: 200_000 });

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "receipt",
      sourceId: receipt.id,
    });

    const data = res.data as PrepareEntriesData;
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].debitAccount).toBe("1.1");
    expect(data.entries[0].creditAccount).toBe("3.1");
    expect(data.entries[0].amountCents).toBe(200_000);
    expect(data.entries[0].entryDate).toBe("2026-08-10");
    expect(data.entries[0].memo).toContain(customer.name);
    expect(res.pending_items).toHaveLength(0);
  });

  it("é idempotente por (sourceType, sourceId): repetição não duplica lançamento", async () => {
    const env = createTestEnv();
    const { payment } = seedExecutedPaymentScenario(env);
    const input = { action: "prepare_entries", sourceType: "payment", sourceId: payment.id };

    const first = await runSkill(contabilSkill, env.ctx(), input);
    const firstData = first.data as PrepareEntriesData;
    expect(firstData.entries).toHaveLength(1);

    const second = await runSkill(contabilSkill, env.ctx(), input);
    const secondData = second.data as PrepareEntriesData;
    expect(secondData.entries).toHaveLength(0);
    expect(secondData.skipped).toEqual([
      { sourceType: "payment", sourceId: payment.id, existingEntryId: firstData.entries[0].id },
    ]);
    expect(second.assumptions.some((a) => a.includes("idempotência"))).toBe(true);
    expect(env.db.accountingEntries).toHaveLength(1);
  });

  it("por período processa liquidações do mês e ignora as de outros meses", async () => {
    const env = createTestEnv();
    seedChart(env);
    const supplier = seedSupplier(env);
    const category = seedCategory(env);
    const payable = seedPayable(env, { supplierId: supplier.id, categoryId: category.id });
    seedPayment(env, { payableId: payable.id, executedAt: "2026-08-15T12:00:00Z" });
    const customer = seedCustomer(env);
    const catRec = seedCategory(env, { kind: "income", dreGroup: "receita_bruta" });
    const receivable = seedReceivable(env, { customerId: customer.id, categoryId: catRec.id });
    seedReceipt(env, { receivableId: receivable.id, receivedDate: "2026-08-10" });
    seedReceipt(env, { receivableId: receivable.id, receivedDate: "2026-07-10" }); // fora do mês

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      period: "2026-08",
    });

    const data = res.data as PrepareEntriesData;
    expect(data.entries).toHaveLength(2);
    expect(data.entries.map((e) => e.sourceType).sort()).toEqual(["payment", "receipt"]);
  });

  it("título sem categoria cai na conta padrão 4.2 com pending_item", async () => {
    const env = createTestEnv();
    seedChart(env);
    const supplier = seedSupplier(env);
    const payable = seedPayable(env, { supplierId: supplier.id, categoryId: undefined });
    const payment = seedPayment(env, { payableId: payable.id });

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payment.id,
    });

    const data = res.data as PrepareEntriesData;
    expect(data.entries[0].debitAccount).toBe("4.2");
    expect(res.pending_items).toHaveLength(1);
    expect(res.pending_items[0].code).toBe("lancamento_sem_categoria");
    expect(res.pending_items[0].entityId).toBe(payable.id);
  });

  it("alerta conta_inexistente quando o código não está no plano de contas", async () => {
    const env = createTestEnv();
    // Plano de contas NÃO semeado.
    const supplier = seedSupplier(env);
    const category = seedCategory(env);
    const payable = seedPayable(env, { supplierId: supplier.id, categoryId: category.id });
    const payment = seedPayment(env, { payableId: payable.id });

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payment.id,
    });

    expect(res.status).toBe("warning");
    const codes = res.alerts.filter((a) => a.code === "conta_inexistente").map((a) => a.entityId);
    expect(codes).toEqual(["1.1", "4.2"]);
    expect(
      env.db.alerts.filter((a) => a.code === "conta_inexistente" && a.status === "open")
    ).toHaveLength(2);
  });

  it("valida a entrada: sourceType sem sourceId e chamada sem modo são rejeitadas", async () => {
    const env = createTestEnv();
    const missing = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
    });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("invalid_input");

    const noMode = await runSkill(contabilSkill, env.ctx(), { action: "prepare_entries" });
    expect(noMode.status).toBe("error");

    const payNotExecuted = seedPayment(env, {
      status: "pending_approval",
      executedAt: undefined,
    });
    const notExecuted = await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payNotExecuted.id,
    });
    expect(notExecuted.status).toBe("error");
  });
});

describe("integracao_contabil_fiscal — export_batch", () => {
  it("exporta CSV em formato BR, marca exported e publica evento", async () => {
    const env = createTestEnv();
    const { payment } = seedExecutedPaymentScenario(env);
    await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payment.id,
    });

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "export_batch",
      period: "2026-08",
      format: "csv",
    });

    expect(res.status).toBe("success");
    const data = res.data as ExportBatchData;
    expect(data.count).toBe(1);
    expect(data.batchId).toBeDefined();
    const lines = data.csv.split("\n");
    expect(lines[0]).toBe("data;conta_debito;conta_credito;valor;historico;origem");
    // 123_456 centavos → "1234,56" (vírgula decimal, sem separador de milhar).
    expect(lines[1]).toContain("2026-08-15;4.2;1.1;1234,56;");
    expect(lines[1]).toContain(`payment:${payment.id}`);

    const stored = env.db.accountingEntries[0];
    expect(stored.exported).toBe(true);
    expect(stored.exportBatchId).toBe(data.batchId);
    expect(env.db.events.filter((e) => e.type === "accounting.batch_exported")).toHaveLength(1);
  });

  it("layout 'dominio' (referência): sem cabeçalho, data BR, TXT e aviso de validação", async () => {
    const env = createTestEnv();
    const { payment } = seedExecutedPaymentScenario(env);
    await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payment.id,
    });

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "export_batch",
      period: "2026-08",
      layout: "dominio",
    });

    expect(res.status).toBe("success");
    const data = res.data as ExportBatchData;
    expect(data.layout).toMatchObject({ id: "dominio", fileExtension: "txt" });
    expect(data.filename).toBe("lancamentos-2026-08-dominio.txt");
    const lines = data.csv.split("\n");
    expect(lines).toHaveLength(1); // sem cabeçalho
    expect(lines[0].startsWith("15/08/2026;4.2;1.1;1234,56;")).toBe(true);
    expect(lines[0]).not.toContain("payment:"); // layout sem coluna de origem
    // Aviso de layout de referência chega nas assumptions e o layout na auditoria.
    expect(res.assumptions.some((a) => a.includes("REFERÊNCIA"))).toBe(true);
    const batchAudit = (await env.repos.audit.list(env.company.id)).find(
      (a) => a.action === "accounting.batch_exported"
    );
    expect(batchAudit?.after).toMatchObject({ layout: "dominio", filename: data.filename });
  });

  it("sem lançamentos pendentes retorna warning com assumption e não gera lote", async () => {
    const env = createTestEnv();
    const { payment } = seedExecutedPaymentScenario(env);
    await runSkill(contabilSkill, env.ctx(), {
      action: "prepare_entries",
      sourceType: "payment",
      sourceId: payment.id,
    });
    await runSkill(contabilSkill, env.ctx(), {
      action: "export_batch",
      period: "2026-08",
      format: "csv",
    });

    const again = await runSkill(contabilSkill, env.ctx(), {
      action: "export_batch",
      period: "2026-08",
      format: "csv",
    });
    expect(again.status).toBe("warning");
    const data = again.data as ExportBatchData;
    expect(data.count).toBe(0);
    expect(data.batchId).toBeUndefined();
    expect(again.assumptions.some((a) => a.includes("Nenhum lançamento pendente"))).toBe(true);
    // Nenhum novo evento de lote.
    expect(env.db.events.filter((e) => e.type === "accounting.batch_exported")).toHaveLength(1);
  });
});

describe("integracao_contabil_fiscal — check_master_data", () => {
  it("encontra as inconsistências plantadas e persiste alerta consolidado", async () => {
    const env = createTestEnv();
    seedChart(env);
    // Inconsistências plantadas:
    const supplierNoDoc = seedSupplier(env, { document: undefined });
    const badCategory = seedCategory(env, { dreGroup: "grupo_invalido" as never });
    env.db.costCenters.push({
      id: "cc_bad",
      companyId: env.company.id,
      code: "CC-99",
      name: "Desativado",
      active: false,
      scope: "both",
    });
    const p1 = seedPayable(env, { supplierId: supplierNoDoc.id, categoryId: undefined }); // sem categoria
    const p2 = seedPayable(env, {
      supplierId: supplierNoDoc.id,
      categoryId: badCategory.id,
      costCenterId: "cc_bad", // centro de custo inativo
      amountCents: 0, // valor inválido
    });
    const customerNoDoc = seedCustomer(env, { document: undefined });
    seedReceivable(env, { customerId: customerNoDoc.id, categoryId: undefined }); // sem categoria

    const res = await runSkill(contabilSkill, env.ctx(), { action: "check_master_data" });

    expect(res.status).toBe("warning");
    const data = res.data as CheckMasterDataData;
    const types = data.issues.map((i) => i.type);
    expect(types).toContain("titulo_sem_categoria");
    expect(types).toContain("titulo_valor_invalido");
    expect(types).toContain("centro_custo_inativo");
    expect(types).toContain("fornecedor_sem_documento");
    expect(types).toContain("cliente_sem_documento");
    expect(types).toContain("categoria_dre_invalido");
    expect(data.count).toBe(data.issues.length);
    expect(res.pending_items).toHaveLength(data.count);
    expect(res.pending_items.every((p) => p.suggestedAction)).toBe(true);
    expect(data.issues.some((i) => i.entityId === p1.id)).toBe(true);
    expect(data.issues.some((i) => i.entityId === p2.id && i.type === "titulo_valor_invalido")).toBe(
      true
    );
    expect(
      env.db.alerts.filter((a) => a.code === "master_data_issues" && a.status === "open")
    ).toHaveLength(1);
  });

  it("sem inconsistências devolve sucesso sem alertas", async () => {
    const env = createTestEnv();
    seedChart(env);
    const supplier = seedSupplier(env);
    const category = seedCategory(env);
    seedPayable(env, { supplierId: supplier.id, categoryId: category.id });

    const res = await runSkill(contabilSkill, env.ctx(), { action: "check_master_data" });
    expect(res.status).toBe("success");
    expect((res.data as CheckMasterDataData).count).toBe(0);
    expect(env.db.alerts).toHaveLength(0);
  });
});

describe("integracao_contabil_fiscal — tax_summary", () => {
  it("resume bases de receita sem calcular imposto (informativo, confiança 0.5)", async () => {
    const env = createTestEnv();
    const customer = seedCustomer(env);
    const r1 = seedReceivable(env, {
      customerId: customer.id,
      issueDate: "2026-08-02",
      amountCents: 300_000,
    });
    seedReceipt(env, { receivableId: r1.id, receivedDate: "2026-08-05", amountCents: 100_000 });
    seedReceipt(env, { receivableId: r1.id, receivedDate: "2026-08-20", amountCents: 50_000 });
    seedReceipt(env, { receivableId: r1.id, receivedDate: "2026-07-05", amountCents: 999_999 }); // fora

    const res = await runSkill(contabilSkill, env.ctx(), {
      action: "tax_summary",
      period: "2026-08",
    });

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(0.5);
    expect(res.requires_human_approval).toBe(false);
    const data = res.data as TaxSummaryData;
    expect(data.taxableRevenueCashCents).toBe(150_000);
    expect(data.taxableRevenueAccrualCents).toBe(300_000);
    expect(data.regime).toBe("simples_nacional"); // vem de ctx.config.taxRules (dados)
    expect(data.formula).toContain("NENHUM imposto");
    expect(res.assumptions.length).toBeGreaterThanOrEqual(2);
    expect(res.assumptions.some((a) => a.includes("não substitui o contador"))).toBe(true);
  });
});
