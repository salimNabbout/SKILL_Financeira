import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type {
  BankAccount,
  BankTransaction,
  Customer,
  Payable,
  Payment,
  Receivable,
  Supplier,
} from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  conciliacaoSkill,
  type AutoMatchData,
  type ConfirmMatchData,
  type ImportStatementData,
  type ReconciliationStatusData,
  type RejectMatchData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 (São Paulo).

let seedSeq = 0;

function seedBankAccount(env: TestEnv, over: Partial<BankAccount> = {}): BankAccount {
  const now = env.clock.now().toISOString();
  const account: BankAccount = {
    id: "ba_1",
    companyId: env.company.id,
    name: "Conta Corrente Principal",
    bankCode: "341",
    agency: "0001",
    accountNumberMasked: "***1234",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 10_000_000,
    openingBalanceDate: "2026-01-01",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.bankAccounts.push(account);
  return account;
}

function seedSupplier(env: TestEnv, over: Partial<Supplier> = {}): Supplier {
  const now = env.clock.now().toISOString();
  const supplier: Supplier = {
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Gama Ltda",
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
    id: "cus_1",
    companyId: env.company.id,
    name: "Cliente Beta Ltda",
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
    description: "Fatura de serviços",
    issueDate: "2026-08-01",
    dueDate: "2026-08-15",
    amountCents: 150_000,
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

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_seed_${++seedSeq}`;
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Compra de insumos",
    issueDate: "2026-08-01",
    dueDate: "2026-08-16",
    amountCents: 25_075,
    paidCents: 0,
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
  env.db.payables.push(payable);
  return payable;
}

function seedPayment(env: TestEnv, over: Partial<Payment> = {}): Payment {
  const now = env.clock.now().toISOString();
  const payment: Payment = {
    id: `pay_seed_${++seedSeq}`,
    companyId: env.company.id,
    payableId: "payb_x",
    bankAccountId: "ba_1",
    amountCents: 30_000,
    scheduledDate: "2026-08-17",
    executedAt: now,
    status: "executed",
    method: "pix",
    requestedBy: "usr_analyst",
    executedBy: "usr_approver",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payments.push(payment);
  return payment;
}

function seedTx(env: TestEnv, over: Partial<BankTransaction> = {}): BankTransaction {
  const now = env.clock.now().toISOString();
  const tx: BankTransaction = {
    id: `tx_seed_${++seedSeq}`,
    companyId: env.company.id,
    bankAccountId: "ba_1",
    date: "2026-08-15",
    amountCents: 150_000,
    currency: "BRL",
    description: "TED RECEBIDA CLIENTE BETA",
    source: "manual",
    reconciled: false,
    createdAt: now,
    ...over,
  };
  env.db.bankTransactions.push(tx);
  return tx;
}

const OFX_SAMPLE = `OFXHEADER:100
DATA:OFXSGML

<OFX>
<BANKACCTFROM>
<ACCTID>12345-6
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260815120000[-3:BRT]
<TRNAMT>1500,00
<FITID>FIT-001
<MEMO>TED RECEBIDA CLIENTE BETA
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260816
<TRNAMT>-250.75
<FITID>FIT-002
<NAME>PAGTO FORNECEDOR GAMA
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260817
<TRNAMT>-99,90
<FITID>FIT-003
<MEMO>TARIFA BANCARIA
</STMTTRN>
</BANKTRANLIST>
</OFX>
`;

async function run(env: TestEnv, input: unknown, actorKey: Parameters<TestEnv["actorFor"]>[0] = "analyst") {
  return runSkill(conciliacaoSkill, env.ctx(env.actorFor(actorKey)), input);
}

describe("conciliacao_bancaria — import_statement", () => {
  it("importa OFX, deduplica por FITID e publica statement.imported", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    const res = await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_SAMPLE,
    });

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    const data = res.data as ImportStatementData;
    expect(data.imported).toBe(3);
    expect(data.duplicates).toBe(0);
    expect(data.warnings).toEqual([]);
    expect(data.transactions).toHaveLength(3);
    expect(data.transactions.map((t) => t.externalId)).toEqual(["FIT-001", "FIT-002", "FIT-003"]);
    expect(data.transactions.map((t) => t.amountCents)).toEqual([150_000, -25_075, -9_990]);
    expect(data.transactions[0]).toMatchObject({
      date: "2026-08-15",
      source: "ofx",
      currency: "BRL",
      reconciled: false,
      bankAccountId: "ba_1",
      importBatchId: data.importBatchId,
    });

    expect(env.db.bankTransactions).toHaveLength(3);
    expect(env.db.events.filter((e) => e.type === "statement.imported")).toHaveLength(1);
    expect(env.db.auditRecords.some((a) => a.action === "statement.imported")).toBe(true);
  });

  it("é idempotente: reimportar o mesmo arquivo não cria nenhuma transação nova", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    const input = {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_SAMPLE,
    };

    await run(env, input);
    const second = await run(env, input);

    const data = second.data as ImportStatementData;
    expect(data.imported).toBe(0);
    expect(data.duplicates).toBe(3);
    expect(data.transactions).toEqual([]);
    expect(env.db.bankTransactions).toHaveLength(3);
    expect(second.assumptions.join(" ")).toContain("idempotente");
  });

  it("CSV sem FITID usa hash determinístico como externalId (reimportação também idempotente)", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    const csv = ["data;descricao;valor", "15/08/2026;PIX RECEBIDO;100,00", "15/08/2026;PIX RECEBIDO;100,00"].join(
      "\n"
    );
    const input = { action: "import_statement", bankAccountId: "ba_1", format: "csv", content: csv };

    const first = await run(env, input);
    // Duas linhas idênticas no MESMO arquivo são transações legítimas (seq difere).
    expect((first.data as ImportStatementData).imported).toBe(2);

    const second = await run(env, input);
    expect((second.data as ImportStatementData).imported).toBe(0);
    expect((second.data as ImportStatementData).duplicates).toBe(2);
    expect(env.db.bankTransactions).toHaveLength(2);
  });

  it("linhas inválidas viram warnings, geram alerta persistido e status warning", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    const csv = ["Data;Histórico;Valor", "15/08/2026;OK;10,00", "data-ruim;QUEBRADA;xx"].join("\n");

    const res = await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "csv",
      content: csv,
    });

    expect(res.status).toBe("warning");
    const data = res.data as ImportStatementData;
    expect(data.imported).toBe(1);
    expect(data.warnings).toHaveLength(1);
    expect(env.db.alerts.some((a) => a.code === "statement_parse_warnings")).toBe(true);
  });

  it("valida conta inexistente e conta inativa", async () => {
    const env = createTestEnv();
    seedBankAccount(env, { id: "ba_off", active: false });

    const missing = await run(env, {
      action: "import_statement",
      bankAccountId: "ba_nao_existe",
      format: "csv",
      content: "data;descricao;valor\n15/08/2026;X;1,00",
    });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("not_found");

    const inactive = await run(env, {
      action: "import_statement",
      bankAccountId: "ba_off",
      format: "csv",
      content: "data;descricao;valor\n15/08/2026;X;1,00",
    });
    expect(inactive.status).toBe("error");
    expect(inactive.alerts[0].code).toBe("validation_error");
  });

  it("entrada inválida é rejeitada pelo schema", async () => {
    const env = createTestEnv();
    const res = await run(env, { action: "import_statement", bankAccountId: "ba_1", format: "xml" });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("invalid_input");
  });
});

describe("conciliacao_bancaria — auto_match", () => {
  it("crédito exato auto-concilia: cria Receipt, baixa o título a receber e marca a transação", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    const receivable = seedReceivable(env, { amountCents: 150_000, dueDate: "2026-08-15" });
    const tx = seedTx(env, {
      amountCents: 150_000,
      date: "2026-08-15",
      description: "TED RECEBIDA CLIENTE BETA",
    });

    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;

    expect(data.autoConfirmed).toBe(1);
    expect(data.suggested).toBe(0);
    expect(data.unmatched).toBe(0);
    // valor exato (0,55) + mesma data (0,25) + "cliente"/"beta" na descrição (0,20) = 1,00
    expect(data.matches[0]).toMatchObject({
      status: "auto_confirmed",
      targetType: "receivable",
      targetId: receivable.id,
      confidence: 1.0,
      matchedBy: "system",
    });

    const receipt = env.db.receipts[0];
    expect(receipt).toMatchObject({
      receivableId: receivable.id,
      bankAccountId: "ba_1",
      amountCents: 150_000,
      receivedDate: "2026-08-15",
      method: "transfer",
      registeredBy: "system",
    });
    const updated = env.db.receivables.find((r) => r.id === receivable.id)!;
    expect(updated.receivedCents).toBe(150_000);
    expect(updated.status).toBe("received");
    expect(env.db.bankTransactions.find((t) => t.id === tx.id)!.reconciled).toBe(true);
    expect(env.db.events.filter((e) => e.type === "reconciliation.auto_matched")).toHaveLength(1);
  });

  it("débito exato baixa o título a pagar SEM criar Payment retroativo", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedSupplier(env);
    const payable = seedPayable(env, { amountCents: 25_075, dueDate: "2026-08-16" });
    seedTx(env, { amountCents: -25_075, date: "2026-08-16", description: "PAGTO FORNECEDOR GAMA" });

    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;

    expect(data.autoConfirmed).toBe(1);
    expect(data.matches[0]).toMatchObject({ targetType: "payable", targetId: payable.id, confidence: 1.0 });

    const updated = env.db.payables.find((p) => p.id === payable.id)!;
    expect(updated.paidCents).toBe(25_075);
    expect(updated.status).toBe("paid");
    expect(env.db.payments).toHaveLength(0);
    expect(res.assumptions.join(" ")).toContain("aprovação de pagamento governa ordens futuras");
  });

  it("débito casando pagamento já executado apenas marca conciliado (sem nova baixa)", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedSupplier(env);
    const payable = seedPayable(env, {
      id: "payb_pago",
      amountCents: 30_000,
      paidCents: 30_000,
      status: "paid",
    });
    const payment = seedPayment(env, { payableId: payable.id, amountCents: 30_000, scheduledDate: "2026-08-17" });
    const tx = seedTx(env, { amountCents: -30_000, date: "2026-08-17", description: "PIX FORNECEDOR GAMA" });

    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;

    expect(data.autoConfirmed).toBe(1);
    expect(data.matches[0]).toMatchObject({ targetType: "payment", targetId: payment.id });
    expect(env.db.bankTransactions.find((t) => t.id === tx.id)!.reconciled).toBe(true);
    expect(env.db.payables.find((p) => p.id === payable.id)!.paidCents).toBe(30_000);
    expect(env.db.receipts).toHaveLength(0);
  });

  it("caso aproximado vira sugestão (sem baixa) com pending_item e alerta persistido", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    const receivable = seedReceivable(env, { amountCents: 50_000, dueDate: "2026-08-10" });
    const tx = seedTx(env, { amountCents: 50_000, date: "2026-08-12", description: "DEPOSITO EM CONTA" });

    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;

    // valor exato (0,55) + 2 dias de diferença dentro da tolerância (0,15) = 0,70 < 0,90
    expect(data.suggested).toBe(1);
    expect(data.autoConfirmed).toBe(0);
    expect(data.matches[0]).toMatchObject({
      status: "suggested",
      targetType: "receivable",
      targetId: receivable.id,
      confidence: 0.7,
    });
    expect(env.db.receipts).toHaveLength(0);
    expect(env.db.receivables.find((r) => r.id === receivable.id)!.receivedCents).toBe(0);
    expect(env.db.bankTransactions.find((t) => t.id === tx.id)!.reconciled).toBe(false);
    expect(res.pending_items).toHaveLength(1);
    expect(res.pending_items[0].entityId).toBe(data.matches[0].id);
    expect(env.db.alerts.some((a) => a.code === "reconciliation_review")).toBe(true);
    expect(env.db.events.filter((e) => e.type === "reconciliation.suggested")).toHaveLength(1);
  });

  it("confiança calculada na mão: tolerância de valor (0,40) + mesma data (0,25) = 0,65", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    seedReceivable(env, { amountCents: 10_000, dueDate: "2026-08-12" });
    // Diferença de 50 centavos <= tolerância (100); descrição sem o nome do cliente.
    seedTx(env, { amountCents: 10_050, date: "2026-08-12", description: "CREDITO EM CONTA" });

    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;

    expect(data.matches[0].confidence).toBe(0.65);
    expect(data.matches[0].status).toBe("suggested");
    expect(res.confidence).toBeLessThan(1.0);
    expect(data.formula).toContain("0,55");
  });

  it("um título não é casado por duas transações além do saldo", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    seedReceivable(env, { amountCents: 50_000, dueDate: "2026-08-15" });
    seedTx(env, { amountCents: 50_000, date: "2026-08-15", description: "DEPOSITO 1" });
    seedTx(env, { amountCents: 50_000, date: "2026-08-15", description: "DEPOSITO 2" });

    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;

    // 0,55 + 0,25 = 0,80 → primeira vira sugestão e reserva o saldo; segunda fica sem par.
    expect(data.suggested).toBe(1);
    expect(data.unmatched).toBe(1);
  });

  it("segunda rodada não duplica sugestões pendentes", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    seedReceivable(env, { amountCents: 50_000, dueDate: "2026-08-10" });
    seedTx(env, { amountCents: 50_000, date: "2026-08-12", description: "DEPOSITO EM CONTA" });

    await run(env, { action: "auto_match" });
    const second = await run(env, { action: "auto_match" });
    const data = second.data as AutoMatchData;

    expect(data.suggested).toBe(0);
    expect(data.matches).toEqual([]);
    expect(env.db.reconciliations).toHaveLength(1);
    expect(second.assumptions.join(" ")).toContain("pendente");
  });
});

describe("conciliacao_bancaria — confirm_match / reject_match", () => {
  async function suggestOne(env: TestEnv) {
    seedBankAccount(env);
    seedCustomer(env);
    const receivable = seedReceivable(env, { amountCents: 50_000, dueDate: "2026-08-10" });
    const tx = seedTx(env, { amountCents: 50_000, date: "2026-08-12", description: "DEPOSITO EM CONTA" });
    const res = await run(env, { action: "auto_match" });
    const matchId = (res.data as AutoMatchData).matches[0].id;
    return { receivable, tx, matchId };
  }

  it("confirm_match aplica a baixa, registra o aprovador humano e publica evento", async () => {
    const env = createTestEnv();
    const { receivable, tx, matchId } = await suggestOne(env);

    const res = await run(env, { action: "confirm_match", matchId }, "manager");
    const data = res.data as ConfirmMatchData;

    expect(res.status).toBe("success");
    expect(data.match).toMatchObject({ status: "confirmed", matchedBy: "usr_manager" });
    expect(data.receipt).toMatchObject({
      receivableId: receivable.id,
      amountCents: 50_000,
      method: "transfer",
      registeredBy: "system",
    });
    const updated = env.db.receivables.find((r) => r.id === receivable.id)!;
    expect(updated.status).toBe("received");
    expect(updated.receivedCents).toBe(50_000);
    expect(env.db.bankTransactions.find((t) => t.id === tx.id)!.reconciled).toBe(true);
    expect(env.db.events.filter((e) => e.type === "reconciliation.confirmed")).toHaveLength(1);
  });

  it("confirm_match é idempotente: confirmar de novo não duplica a baixa", async () => {
    const env = createTestEnv();
    const { matchId } = await suggestOne(env);

    await run(env, { action: "confirm_match", matchId }, "manager");
    const second = await run(env, { action: "confirm_match", matchId }, "manager");

    expect(second.status).toBe("success");
    expect(second.assumptions.join(" ")).toContain("idempotente");
    expect(env.db.receipts).toHaveLength(1);
  });

  it("reject_match libera a transação e o par rejeitado não volta a ser sugerido", async () => {
    const env = createTestEnv();
    const { receivable, tx, matchId } = await suggestOne(env);

    const res = await run(env, { action: "reject_match", matchId, notes: "não é este cliente" }, "manager");
    const data = res.data as RejectMatchData;

    expect(data.match).toMatchObject({ status: "rejected", notes: "não é este cliente" });
    expect(env.db.bankTransactions.find((t) => t.id === tx.id)!.reconciled).toBe(false);
    expect(env.db.receivables.find((r) => r.id === receivable.id)!.receivedCents).toBe(0);
    expect(env.db.events.filter((e) => e.type === "reconciliation.rejected")).toHaveLength(1);

    const rematch = await run(env, { action: "auto_match" });
    const rematchData = rematch.data as AutoMatchData;
    expect(rematchData.suggested).toBe(0);
    expect(rematchData.unmatched).toBe(1);
    expect(env.db.reconciliations).toHaveLength(1);
  });

  it("match inexistente e rejeição de match já aplicado são erros claros", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    seedReceivable(env, { amountCents: 150_000, dueDate: "2026-08-15" });
    seedTx(env, { amountCents: 150_000, date: "2026-08-15", description: "TED CLIENTE BETA" });
    const autoRes = await run(env, { action: "auto_match" });
    const autoMatchId = (autoRes.data as AutoMatchData).matches[0].id;

    const notFound = await run(env, { action: "confirm_match", matchId: "rec_nao_existe" });
    expect(notFound.status).toBe("error");
    expect(notFound.alerts[0].code).toBe("not_found");

    const rejectApplied = await run(env, { action: "reject_match", matchId: autoMatchId });
    expect(rejectApplied.status).toBe("error");
    expect(rejectApplied.alerts[0].code).toBe("validation_error");
  });
});

describe("conciliacao_bancaria — reconciliation_status", () => {
  it("consolida não conciliadas, sugeridas pendentes e conciliadas no mês", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedCustomer(env);
    // Auto-conciliada:
    seedReceivable(env, { amountCents: 150_000, dueDate: "2026-08-15" });
    seedTx(env, { amountCents: 150_000, date: "2026-08-15", description: "TED CLIENTE BETA" });
    // Sugerida pendente:
    seedReceivable(env, { amountCents: 50_000, dueDate: "2026-08-10" });
    seedTx(env, { amountCents: 50_000, date: "2026-08-12", description: "DEPOSITO EM CONTA" });
    // Sem par:
    seedTx(env, { amountCents: -9_990, date: "2026-08-17", description: "TARIFA BANCARIA" });
    await run(env, { action: "auto_match" });

    const res = await run(env, { action: "reconciliation_status" });
    const data = res.data as ReconciliationStatusData;

    expect(data.reconciledInMonthCount).toBe(1);
    expect(data.suggestedPendingCount).toBe(1);
    expect(data.unreconciledCount).toBe(2); // sugerida (ainda não confirmada) + tarifa sem par
    expect(data.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(res.pending_items).toHaveLength(1);
    expect(res.confidence).toBe(1.0);
  });
});
