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
  type SyncBankData,
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

// Mesmo arquivo, com o saldo declarado pelo banco no fim.
/** OFX com saldo declarado e FITIDs próprios (para não deduplicar entre lotes). */
function comSaldo(base: string, valor: string, dtasof: string, prefixo: string): string {
  return base
    .replace(/FIT-00(\d)/g, `${prefixo}-$1`)
    .replace(
      "</BANKTRANLIST>",
      `</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${valor}
<DTASOF>${dtasof}
</LEDGERBAL>`
    );
}

const OFX_COM_SALDO = OFX_SAMPLE.replace(
  "</BANKTRANLIST>",
  `</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>4200,50
<DTASOF>20260817
</LEDGERBAL>`
);

describe("conciliacao_bancaria — lote de importação (StatementImport)", () => {
  it("grava o lote com o saldo que o banco declarou", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    const res = await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_COM_SALDO,
    });
    const data = res.data as ImportStatementData;

    expect(env.db.statementImports).toHaveLength(1);
    const lote = env.db.statementImports[0];
    // O id do lote é o mesmo importBatchId gravado nas transações: dá para ir
    // do lançamento ao lote sem coluna nova.
    expect(lote.id).toBe(data.importBatchId);
    expect(env.db.bankTransactions.every((t) => t.importBatchId === lote.id)).toBe(true);
    expect(lote).toMatchObject({
      bankAccountId: "ba_1",
      format: "ofx",
      source: "ofx",
      imported: 3,
      duplicates: 0,
      ledgerBalanceCents: 420_050,
      ledgerBalanceDate: "2026-08-17",
    });
  });

  it("arquivo sem LEDGERBAL: lote sem saldo, e isso não é erro", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_SAMPLE,
    });

    const lote = env.db.statementImports[0];
    expect(lote.ledgerBalanceCents).toBeUndefined();
    expect(lote.ledgerBalanceDate).toBeUndefined();
    expect(lote.warnings).toEqual([]);
  });

  it("reimportar não duplica transações, MAS registra o novo lote", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    const input = {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_COM_SALDO,
    };

    await run(env, input);
    await run(env, input);

    // As transações continuam idempotentes...
    expect(env.db.bankTransactions).toHaveLength(3);
    // ...mas os dois lotes existem: o saldo do banco pode ter mudado entre eles,
    // e a auditoria precisa do mais recente.
    expect(env.db.statementImports).toHaveLength(2);
    expect(env.db.statementImports[1]).toMatchObject({ imported: 0, duplicates: 3 });
  });

  it("escolhe pela DATA-BASE, não pela ordem de importação", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    // Ordem invertida de propósito: primeiro entra o arquivo com a data-base
    // MAIS NOVA, depois o com a data-base mais velha. Ordenar por createdAt
    // devolveria o segundo — e o saldo conferido seria o desatualizado.
    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: comSaldo(OFX_SAMPLE, "9999,00", "20260831", "FIT-A"),
    });
    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: comSaldo(OFX_SAMPLE, "1111,00", "20260810", "FIT-B"),
    });

    expect(env.db.statementImports).toHaveLength(2);
    // O último importado é o de data-base mais velha...
    expect(env.db.statementImports[1].ledgerBalanceCents).toBe(111_100);

    // ...mas a referência tem de ser a data-base mais recente.
    const achado = await env.repos.statementImports.latestWithBalanceBefore(
      env.company.id,
      "ba_1",
      "2026-09-30"
    );
    expect(achado?.ledgerBalanceCents).toBe(999_900);
    expect(achado?.ledgerBalanceDate).toBe("2026-08-31");
  });

  it("mesma data-base em dois lotes: vence o importado por último", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: comSaldo(OFX_SAMPLE, "500,00", "20260831", "FIT-C"),
    });
    // O relógio do ambiente de teste é fixo: sem avançá-lo, os dois lotes
    // teriam o MESMO createdAt e não haveria desempate para exercitar.
    env.clock.set("2026-08-18T16:00:00Z");
    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: comSaldo(OFX_SAMPLE, "700,00", "20260831", "FIT-D"),
    });

    const achado = await env.repos.statementImports.latestWithBalanceBefore(
      env.company.id,
      "ba_1",
      "2026-09-30"
    );
    // Empate na data-base: o desempate é por createdAt, então o arquivo mais
    // recente corrige o saldo do anterior.
    expect(achado?.ledgerBalanceCents).toBe(700_00);
  });

  it("latestWithBalanceBefore ignora lote sem saldo e respeita a data-base", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    // Primeiro um arquivo COM saldo, depois um SEM (o mais recente).
    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_COM_SALDO,
    });
    await run(env, {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "ofx",
      content: OFX_SAMPLE.replace("FIT-001", "FIT-901"),
    });

    const achado = await env.repos.statementImports.latestWithBalanceBefore(
      env.company.id,
      "ba_1",
      "2026-08-31"
    );
    expect(achado?.ledgerBalanceCents).toBe(420_050);

    // Data-base anterior ao saldo: nenhuma referência disponível.
    const antes = await env.repos.statementImports.latestWithBalanceBefore(
      env.company.id,
      "ba_1",
      "2026-08-16"
    );
    expect(antes).toBeNull();
  });
});

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

describe("conciliacao_bancaria — despesa bancária (bank_fee)", () => {
  /** Débito de tarifa, sem título a pagar correspondente. */
  async function sugerirTarifa(env: TestEnv, description = "TARIFA PACOTE SERVICOS") {
    seedBankAccount(env);
    const tx = seedTx(env, { amountCents: -3_651, date: "2026-08-18", description });
    const res = await run(env, { action: "auto_match" });
    const data = res.data as AutoMatchData;
    return { tx, data };
  }

  it("débito de tarifa vira sugestão bank_fee, nunca automática", async () => {
    const env = createTestEnv();
    const { tx, data } = await sugerirTarifa(env);

    expect(data.suggested).toBe(1);
    expect(data.autoConfirmed).toBe(0);
    const match = data.matches[0];
    expect(match.targetType).toBe("bank_fee");
    expect(match.targetId).toBeUndefined();
    expect(match.status).toBe("suggested");
    expect(match.confidence).toBe(0.8);
    expect(match.amountCents).toBe(3_651);
    expect(match.notes).toContain("despesa bancária");
    expect(match.bankTransactionId).toBe(tx.id);
    expect(env.db.events.some((e) => e.type === "reconciliation.suggested")).toBe(true);
  });

  it("pega IOF, juros, encargo, cesta e anuidade — e ignora crédito", async () => {
    for (const d of ["IOF SOBRE OPERACAO", "JUROS DE MORA", "ENCARGOS DE CONTA", "CESTA MAIS SERVICOS", "ANUIDADE CARTAO"]) {
      const env = createTestEnv();
      const { data } = await sugerirTarifa(env, d);
      expect(data.matches[0]?.targetType).toBe("bank_fee");
    }
    // Crédito com a mesma palavra não é despesa bancária.
    const env = createTestEnv();
    seedBankAccount(env);
    seedTx(env, { amountCents: 3_651, description: "ESTORNO TARIFA" });
    const res = await run(env, { action: "auto_match" });
    expect((res.data as AutoMatchData).suggested).toBe(0);
  });

  it("confirmar concilia a transação e lança a despesa; confirmar de novo não duplica", async () => {
    const env = createTestEnv();
    const { tx, data } = await sugerirTarifa(env);
    const matchId = data.matches[0].id;

    const res = await run(env, { action: "confirm_match", matchId }, "manager");
    expect(res.status).toBe("success");
    expect((res.data as ConfirmMatchData).match.status).toBe("confirmed");

    const txAfter = await env.repos.bankTransactions.getById(env.company.id, tx.id);
    expect(txAfter?.reconciled).toBe(true);

    const lancamentos = env.db.accountingEntries.filter((e) => e.sourceId === `fee:${tx.id}`);
    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]).toMatchObject({
      sourceType: "adjustment",
      amountCents: 3_651,
      entryDate: "2026-08-18",
      exported: false,
    });
    expect(lancamentos[0].memo).toContain("Despesa bancária");
    // Débito em despesa, crédito em caixa (saiu dinheiro).
    expect(lancamentos[0].debitAccount).not.toBe(lancamentos[0].creditAccount);

    // Idempotente: confirmar de novo não lança segunda despesa.
    await run(env, { action: "confirm_match", matchId }, "manager");
    expect(env.db.accountingEntries.filter((e) => e.sourceId === `fee:${tx.id}`)).toHaveLength(1);
  });

  it("rejeitar mantém a transação NÃO conciliada e sem lançamento", async () => {
    const env = createTestEnv();
    const { tx, data } = await sugerirTarifa(env);

    const res = await run(
      env,
      { action: "reject_match", matchId: data.matches[0].id, notes: "não é tarifa" },
      "manager"
    );

    expect(res.status).toBe("success");
    const txAfter = await env.repos.bankTransactions.getById(env.company.id, tx.id);
    expect(txAfter?.reconciled).toBe(false);
    expect(env.db.accountingEntries.filter((e) => e.sourceId === `fee:${tx.id}`)).toHaveLength(0);
  });

  it("tarifa NÃO rouba a fase 1: débito exato de um título a pagar continua casando", async () => {
    const env = createTestEnv();
    seedBankAccount(env);
    seedSupplier(env);
    const payable = seedPayable(env, { amountCents: 3_651, dueDate: "2026-08-18" });
    // Descrição com "tarifa" MAS com título exato: a fase 1 decide antes.
    seedTx(env, { amountCents: -3_651, date: "2026-08-18", description: "TARIFA FORNECEDORA ALFA" });

    const data = (await run(env, { action: "auto_match" })).data as AutoMatchData;

    expect(data.matches[0].targetType).toBe("payable");
    expect(data.matches[0].targetId).toBe(payable.id);
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
    // Tarifa bancária: não tem título do outro lado, mas deixou de ficar órfã —
    // vira sugestão de despesa bancária (bank_fee), que ainda aguarda revisão.
    seedTx(env, { amountCents: -9_990, date: "2026-08-17", description: "TARIFA BANCARIA" });
    await run(env, { action: "auto_match" });

    const res = await run(env, { action: "reconciliation_status" });
    const data = res.data as ReconciliationStatusData;

    expect(data.reconciledInMonthCount).toBe(1);
    expect(data.suggestedPendingCount).toBe(2); // depósito + despesa bancária
    expect(data.unreconciledCount).toBe(2); // as duas sugeridas seguem não conciliadas
    expect(data.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(res.pending_items).toHaveLength(2);
    expect(res.confidence).toBe(1.0);
  });
});

describe("conciliacao_bancaria — sync_bank", () => {
  it("sincroniza via provedor mock (extrato sintético determinístico), audita e publica evento", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    const res = await run(env, { action: "sync_bank", bankAccountId: "ba_1", sinceDays: 30 });

    expect(res.status).toBe("success");
    const data = res.data as SyncBankData;
    expect(data.provider).toBe("mock");
    expect(data.period).toEqual({ since: "2026-07-19", until: "2026-08-18" });
    expect(data.imported).toBeGreaterThan(0);
    expect(data.duplicates).toBe(0);
    expect(data.transactions).toHaveLength(data.imported);
    for (const t of data.transactions) {
      expect(t.source).toBe("api_mock");
      expect(t.externalId).toMatch(/^sync:mock:mock-/);
      expect(t.reconciled).toBe(false);
    }
    // Mock claramente identificado na resposta.
    expect(res.assumptions.join(" ").toLowerCase()).toContain("mock");

    expect(env.db.auditRecords.some((a) => a.action === "statement.synced")).toBe(true);
    const events = env.db.events.filter((e) => e.type === "statement.imported");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ format: "sync", provider: "mock" });
  });

  it("ressincronizar o mesmo período é idempotente: tudo vira duplicata, nada é criado", async () => {
    const env = createTestEnv();
    seedBankAccount(env);

    const first = await run(env, { action: "sync_bank", bankAccountId: "ba_1" });
    const imported = (first.data as SyncBankData).imported;
    expect(imported).toBeGreaterThan(0);

    const second = await run(env, { action: "sync_bank", bankAccountId: "ba_1" });
    const data = second.data as SyncBankData;
    expect(data.imported).toBe(0);
    expect(data.duplicates).toBe(imported);
    expect(env.db.bankTransactions).toHaveLength(imported);
  });

  it("rejeita conta inexistente ou inativa", async () => {
    const env = createTestEnv();
    seedBankAccount(env, { active: false });

    const missing = await run(env, { action: "sync_bank", bankAccountId: "ba_404" });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("not_found");

    const inactive = await run(env, { action: "sync_bank", bankAccountId: "ba_1" });
    expect(inactive.status).toBe("error");
    expect(inactive.alerts[0].code).toBe("validation_error");
  });
});
