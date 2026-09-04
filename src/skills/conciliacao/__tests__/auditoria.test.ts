/**
 * Auditoria de conciliação — extrato × baixas.
 *
 * O que importa aqui: o que a auditoria ACUSA, o que ela deixa passar de
 * propósito, e que reexecutar não infla a central de pendências.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { BankAccount, BankTransaction, Payable, Payment, Receipt } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { conciliacaoSkill, type ReconciliationAuditData } from "../index";

const AGOSTO = "2026-08";
let seq = 0;

function conta(env: TestEnv, over: Partial<BankAccount> = {}): BankAccount {
  const now = env.clock.now().toISOString();
  const c: BankAccount = {
    id: "ba_1",
    companyId: env.company.id,
    name: "Itaú",
    bankCode: "341",
    agency: "0001",
    accountNumberMasked: "****0135",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 100_000,
    openingBalanceDate: "2026-08-01",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.bankAccounts.push(c);
  return c;
}

function titulo(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const p: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Energia elétrica",
    issueDate: "2026-08-01",
    dueDate: "2026-08-20",
    amountCents: 30_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(p);
  return p;
}

function pagamento(env: TestEnv, over: Partial<Payment> = {}): Payment {
  const now = env.clock.now().toISOString();
  const p: Payment = {
    id: `pay_${++seq}`,
    companyId: env.company.id,
    payableId: "payb_x",
    bankAccountId: "ba_1",
    amountCents: 30_000,
    scheduledDate: "2026-08-17",
    executedAt: "2026-08-17T13:00:00.000Z",
    status: "executed",
    requestedBy: "usr_analyst",
    executedBy: "usr_approver",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payments.push(p);
  return p;
}

function recibo(env: TestEnv, over: Partial<Receipt> = {}): Receipt {
  const now = env.clock.now().toISOString();
  const r: Receipt = {
    id: `rcp_${++seq}`,
    companyId: env.company.id,
    receivableId: "recv_x",
    bankAccountId: "ba_1",
    amountCents: 50_000,
    receivedDate: "2026-08-12",
    method: "pix",
    registeredBy: "usr_analyst",
    createdAt: now,
    ...over,
  };
  env.db.receipts.push(r);
  return r;
}

function transacao(env: TestEnv, over: Partial<BankTransaction> = {}): BankTransaction {
  const now = env.clock.now().toISOString();
  const t: BankTransaction = {
    id: `btx_${++seq}`,
    companyId: env.company.id,
    bankAccountId: "ba_1",
    date: "2026-08-14",
    amountCents: -12_000,
    currency: "BRL",
    description: "TARIFA PACOTE SERVICOS",
    source: "ofx",
    reconciled: false,
    createdAt: now,
    ...over,
  };
  env.db.bankTransactions.push(t);
  return t;
}

async function auditar(env: TestEnv, extra: Record<string, unknown> = {}) {
  const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
    action: "reconciliation_audit",
    period: AGOSTO,
    ...extra,
  });
  return res.data as ReconciliationAuditData;
}

describe("reconciliation_audit — cenário limpo", () => {
  it("sem movimentação, tudo zerado", async () => {
    const env = createTestEnv();
    conta(env);

    const d = await auditar(env);

    expect(d.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(d.totals).toEqual({
      unexplainedCount: 0,
      unexplainedCents: 0,
      settlementsWithoutBankCount: 0,
      settlementsWithoutBankCents: 0,
      amountMismatchCount: 0,
      balanceMismatchCount: 0,
    });
    expect(env.db.alerts).toHaveLength(0);
  });

  it("aceita período como intervalo explícito", async () => {
    const env = createTestEnv();
    conta(env);

    const d = await auditar(env, { period: { start: "2026-08-10", end: "2026-08-20" } });

    expect(d.period).toEqual({ start: "2026-08-10", end: "2026-08-20" });
  });

  it("recusa intervalo invertido", async () => {
    const env = createTestEnv();
    conta(env);

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: { start: "2026-08-20", end: "2026-08-10" },
    });

    expect(res.status).toBe("error");
  });
});

describe("reconciliation_audit — baixas sem lastro", () => {
  it("pagamento executado sem conciliação aparece e gera alerta", async () => {
    const env = createTestEnv();
    conta(env);
    const t = titulo(env, { description: "Conta de luz" });
    const pag = pagamento(env, { payableId: t.id, amountCents: 30_000 });

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.settlementsWithoutBank[0]).toMatchObject({
      kind: "payment",
      id: pag.id,
      date: "2026-08-17",
      amountCents: 30_000,
      description: "Conta de luz",
    });
    expect(d.totals.settlementsWithoutBankCents).toBe(30_000);

    const alerta = env.db.alerts.filter(
      (a) => a.code === "reconciliation_settlement_without_bank"
    );
    expect(alerta).toHaveLength(1);
    expect(alerta[0].entityId).toBe(pag.id);
  });

  it("reexecutar três vezes não duplica o alerta", async () => {
    const env = createTestEnv();
    conta(env);
    const t = titulo(env);
    pagamento(env, { payableId: t.id });

    await auditar(env);
    await auditar(env);
    await auditar(env);

    expect(
      env.db.alerts.filter((a) => a.code === "reconciliation_settlement_without_bank")
    ).toHaveLength(1);
  });

  it("pagamento conciliado NÃO é divergência", async () => {
    const env = createTestEnv();
    conta(env);
    const t = titulo(env);
    const pag = pagamento(env, { payableId: t.id });
    const tx = transacao(env, { amountCents: -30_000, reconciled: true });
    env.db.reconciliations.push({
      id: "mtc_1",
      companyId: env.company.id,
      bankTransactionId: tx.id,
      targetType: "payment",
      targetId: pag.id,
      confidence: 1,
      status: "confirmed",
      matchedBy: "usr_analyst",
      createdAt: env.clock.now().toISOString(),
      updatedAt: env.clock.now().toISOString(),
    });

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(0);
    expect(d.unexplainedBankTransactions).toHaveLength(0);
  });

  it("pagamento fora do período não entra", async () => {
    const env = createTestEnv();
    conta(env);
    pagamento(env, { executedAt: "2026-07-20T13:00:00.000Z" });

    expect((await auditar(env)).settlementsWithoutBank).toHaveLength(0);
  });

  it("recebimento SEM conta bancária vira suposição, não divergência", async () => {
    const env = createTestEnv();
    conta(env);
    recibo(env, { bankAccountId: undefined });

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: AGOSTO,
    });
    const d = res.data as ReconciliationAuditData;

    expect(d.settlementsWithoutBank).toHaveLength(0);
    expect(res.assumptions.some((a) => a.includes("dinheiro/caixa"))).toBe(true);
  });

  it("recebimento com conta e sem conciliação é divergência", async () => {
    const env = createTestEnv();
    conta(env);
    const r = recibo(env);

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.settlementsWithoutBank[0]).toMatchObject({ kind: "receipt", id: r.id });
  });

  it("título pago sem Payment é baixa manual sem lastro", async () => {
    const env = createTestEnv();
    conta(env);
    titulo(env, {
      paidCents: 30_000,
      status: "paid",
      updatedAt: "2026-08-19T10:00:00.000Z",
      description: "Baixado na mão",
    });

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.settlementsWithoutBank[0]).toMatchObject({
      kind: "payable_paid_without_payment",
      amountCents: 30_000,
      date: "2026-08-19",
    });
  });

  it("título pago COM Payment executado não conta duas vezes", async () => {
    const env = createTestEnv();
    conta(env);
    const t = titulo(env, { paidCents: 30_000, status: "paid", updatedAt: "2026-08-19T10:00:00.000Z" });
    pagamento(env, { payableId: t.id });

    const d = await auditar(env);

    // Só o pagamento aparece — o título não vira uma segunda linha.
    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.settlementsWithoutBank[0].kind).toBe("payment");
  });
});

describe("reconciliation_audit — extrato sem explicação", () => {
  it("lista transação não conciliada e marca se tem sugestão", async () => {
    const env = createTestEnv();
    conta(env);
    const semSugestao = transacao(env, { description: "TARIFA" });
    const comSugestao = transacao(env, { description: "PIX RECEBIDO", amountCents: 5_000 });
    env.db.reconciliations.push({
      id: "mtc_s",
      companyId: env.company.id,
      bankTransactionId: comSugestao.id,
      targetType: "receivable",
      targetId: "recv_1",
      confidence: 0.7,
      status: "suggested",
      matchedBy: "system",
      createdAt: env.clock.now().toISOString(),
      updatedAt: env.clock.now().toISOString(),
    });

    const d = await auditar(env);

    expect(d.unexplainedBankTransactions).toHaveLength(2);
    expect(d.unexplainedBankTransactions.find((t) => t.id === semSugestao.id)?.hasSuggestion).toBe(
      false
    );
    expect(d.unexplainedBankTransactions.find((t) => t.id === comSugestao.id)?.hasSuggestion).toBe(
      true
    );
    // Total em MÓDULO: o que importa é o volume sem explicação.
    expect(d.totals.unexplainedCents).toBe(17_000);
    // Extrato sem explicação NÃO gera alerta — só pendência.
    expect(env.db.alerts.filter((a) => a.code.startsWith("reconciliation_"))).toHaveLength(0);
  });
});

describe("reconciliation_audit — valores divergentes", () => {
  it("acusa conciliação fora da tolerância e ignora dentro dela", async () => {
    const env = createTestEnv();
    conta(env);
    const t = titulo(env);
    const pagOk = pagamento(env, { payableId: t.id, amountCents: 30_000 });
    const pagRuim = pagamento(env, { payableId: t.id, amountCents: 30_000 });
    const txOk = transacao(env, { amountCents: -30_050, reconciled: true }); // R$ 0,50: dentro
    const txRuim = transacao(env, { amountCents: -45_000, reconciled: true }); // R$ 150: fora
    const base = {
      companyId: env.company.id,
      confidence: 1,
      status: "confirmed" as const,
      matchedBy: "usr_analyst",
      createdAt: env.clock.now().toISOString(),
      updatedAt: env.clock.now().toISOString(),
    };
    env.db.reconciliations.push(
      { ...base, id: "m_ok", bankTransactionId: txOk.id, targetType: "payment", targetId: pagOk.id },
      {
        ...base,
        id: "m_ruim",
        bankTransactionId: txRuim.id,
        targetType: "payment",
        targetId: pagRuim.id,
      }
    );

    const d = await auditar(env);

    expect(d.amountMismatches).toHaveLength(1);
    expect(d.amountMismatches[0]).toMatchObject({
      matchId: "m_ruim",
      appliedCents: 45_000,
      expectedCents: 30_000,
      diffCents: 15_000,
    });
    // Divergência de valor não gera alerta, só pendência.
    expect(env.db.alerts.filter((a) => a.code === "reconciliation_amount_mismatch")).toHaveLength(0);
  });

  it("ignora tarifa bancária: não há título do outro lado", async () => {
    const env = createTestEnv();
    conta(env);
    const tx = transacao(env, { amountCents: -9_900, reconciled: true });
    env.db.reconciliations.push({
      id: "m_fee",
      companyId: env.company.id,
      bankTransactionId: tx.id,
      targetType: "bank_fee",
      confidence: 1,
      status: "confirmed",
      matchedBy: "usr_analyst",
      createdAt: env.clock.now().toISOString(),
      updatedAt: env.clock.now().toISOString(),
    });

    expect((await auditar(env)).amountMismatches).toHaveLength(0);
  });
});

describe("reconciliation_audit — saldo do banco × saldo do app", () => {
  function comSaldo(env: TestEnv, cents: number, date = "2026-08-31") {
    env.db.statementImports.push({
      id: `imp_${++seq}`,
      companyId: env.company.id,
      bankAccountId: "ba_1",
      format: "ofx",
      source: "ofx",
      imported: 0,
      duplicates: 0,
      warnings: [],
      ledgerBalanceCents: cents,
      ledgerBalanceDate: date,
      createdBy: "usr_analyst",
      createdAt: env.clock.now().toISOString(),
    });
  }

  it("sem lote com saldo: conta fora da lista, com suposição", async () => {
    const env = createTestEnv();
    conta(env);

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: AGOSTO,
    });
    const d = res.data as ReconciliationAuditData;

    expect(d.balanceChecks).toHaveLength(0);
    expect(res.assumptions.some((a) => a.includes("Sem saldo de referência"))).toBe(true);
  });

  it("saldos batendo: diferença zero e nenhum alerta", async () => {
    const env = createTestEnv();
    conta(env); // saldo inicial R$ 1.000,00
    comSaldo(env, 100_000);

    const d = await auditar(env);

    expect(d.balanceChecks).toHaveLength(1);
    expect(d.balanceChecks[0]).toMatchObject({ diffCents: 0, residualCents: 0 });
    expect(d.totals.balanceMismatchCount).toBe(0);
    expect(env.db.alerts.filter((a) => a.code === "reconciliation_balance_mismatch")).toHaveLength(
      0
    );
  });

  it("diferença EXPLICADA por extrato não conciliado não alerta", async () => {
    const env = createTestEnv();
    conta(env);
    // R$ 120 de débito no extrato, ainda não conciliado: o app não o conta,
    // o banco sim. A diferença é real mas totalmente explicável.
    transacao(env, { amountCents: -12_000, reconciled: false, date: "2026-08-14" });
    comSaldo(env, 88_000); // 100.000 − 12.000

    const d = await auditar(env);

    const b = d.balanceChecks[0];
    expect(b.diffCents).toBe(12_000);
    expect(b.explainedCents).toBe(12_000);
    expect(b.residualCents).toBe(0);
    expect(env.db.alerts.filter((a) => a.code === "reconciliation_balance_mismatch")).toHaveLength(
      0
    );
  });

  it("resíduo sem explicação alerta, e a severidade segue a faixa", async () => {
    const env = createTestEnv();
    conta(env);
    // Banco diz R$ 500,00; app calcula R$ 1.000,00; nada explica a diferença.
    comSaldo(env, 50_000);

    const d = await auditar(env);

    const b = d.balanceChecks[0];
    expect(b.diffCents).toBe(50_000);
    expect(b.explainedCents).toBe(0);
    expect(b.residualCents).toBe(50_000);
    expect(d.totals.balanceMismatchCount).toBe(1);

    const alerta = env.db.alerts.find((a) => a.code === "reconciliation_balance_mismatch");
    // Tolerância padrão R$ 1,00 → crítico acima de R$ 100,00.
    expect(alerta?.severity).toBe("critical");
    expect(alerta?.entityId).toBe("ba_1");
  });

  it("resíduo pequeno é warning, não crítico", async () => {
    const env = createTestEnv();
    conta(env);
    comSaldo(env, 99_950); // R$ 0,50 de resíduo

    await auditar(env);

    expect(env.db.alerts.find((a) => a.code === "reconciliation_balance_mismatch")?.severity).toBe(
      "warning"
    );
  });
});

describe("reconciliation_audit — filtro por conta", () => {
  it("restringe extrato e baixas à conta informada", async () => {
    const env = createTestEnv();
    conta(env);
    conta(env, { id: "ba_2", name: "Nubank", accountNumberMasked: "****9999" });
    transacao(env, { bankAccountId: "ba_1", description: "DA CONTA 1" });
    transacao(env, { bankAccountId: "ba_2", description: "DA CONTA 2" });
    pagamento(env, { bankAccountId: "ba_2" });

    const d = await auditar(env, { bankAccountId: "ba_1" });

    expect(d.bankAccountId).toBe("ba_1");
    expect(d.unexplainedBankTransactions).toHaveLength(1);
    expect(d.unexplainedBankTransactions[0].description).toBe("DA CONTA 1");
    expect(d.settlementsWithoutBank).toHaveLength(0);
  });

  it("conta inexistente é erro, não lista vazia", async () => {
    const env = createTestEnv();
    conta(env);

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: AGOSTO,
      bankAccountId: "ba_inexistente",
    });

    expect(res.status).toBe("error");
  });
});

describe("reconciliation_audit — evento", () => {
  it("publica reconciliation.audited com os totais", async () => {
    const env = createTestEnv();
    conta(env);
    const t = titulo(env);
    pagamento(env, { payableId: t.id });

    await auditar(env);

    const ev = env.db.events.filter((e) => e.type === "reconciliation.audited");
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { totals: { settlementsWithoutBankCount: number } }).totals
      .settlementsWithoutBankCount).toBe(1);
  });
});
