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

/**
 * Estabelece até onde o extrato importado enxerga. Sem isto, a auditoria trata
 * toda baixa como "aguardando importação do extrato" e não acusa nada — que é
 * o comportamento correto, mas atrapalha o teste do resto.
 */
function cobertura(
  env: TestEnv,
  date = "2026-08-31",
  bankAccountId = "ba_1",
  ledgerBalanceCents = 100_000
) {
  env.db.statementImports.push({
    id: `imp_cob_${++seq}`,
    companyId: env.company.id,
    bankAccountId,
    format: "ofx",
    source: "ofx",
    imported: 0,
    duplicates: 0,
    warnings: [],
    ledgerBalanceCents,
    ledgerBalanceDate: date,
    createdBy: "usr_analyst",
    createdAt: env.clock.now().toISOString(),
  });
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
      pendingCoverageCount: 0,
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
    cobertura(env);
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
    cobertura(env);
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
    cobertura(env);
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
    cobertura(env);
    const r = recibo(env);

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.settlementsWithoutBank[0]).toMatchObject({ kind: "receipt", id: r.id });
  });

  it("título pago sem Payment é baixa manual sem lastro", async () => {
    const env = createTestEnv();
    conta(env);
    cobertura(env);
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
    cobertura(env);
    const t = titulo(env, { paidCents: 30_000, status: "paid", updatedAt: "2026-08-19T10:00:00.000Z" });
    pagamento(env, { payableId: t.id });

    const d = await auditar(env);

    // Só o pagamento aparece — o título não vira uma segunda linha.
    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.settlementsWithoutBank[0].kind).toBe("payment");
  });
});

describe("reconciliation_audit — cobertura do extrato", () => {
  it("baixa DENTRO da janela de tolerância não alerta: o extrato ainda não a alcança", async () => {
    const env = createTestEnv();
    conta(env);
    // Extrato vai até 18/08; a tolerância padrão é de 3 dias, então a fronteira
    // efetiva é 15/08. Um pagamento em 17/08 ainda pode não ter sido publicado.
    cobertura(env, "2026-08-18");
    const t = titulo(env);
    pagamento(env, { payableId: t.id, executedAt: "2026-08-17T13:00:00.000Z" });

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: AGOSTO,
    });
    const d = res.data as ReconciliationAuditData;

    expect(d.settlementsWithoutBank).toHaveLength(0);
    expect(d.totals.pendingCoverageCount).toBe(1);
    expect(env.db.alerts).toHaveLength(0);
    expect(res.assumptions.some((a) => a.includes("aguardam importação do extrato"))).toBe(true);
  });

  it("baixa ANTERIOR à cobertura alerta: o extrato já passou por ali", async () => {
    const env = createTestEnv();
    conta(env);
    // Mesma cobertura de 18/08, mas o pagamento é de 10/08: já devia constar.
    cobertura(env, "2026-08-18");
    const t = titulo(env);
    pagamento(env, { payableId: t.id, executedAt: "2026-08-10T13:00:00.000Z" });

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.totals.pendingCoverageCount).toBe(0);
    expect(
      env.db.alerts.filter((a) => a.code === "reconciliation_settlement_without_bank")
    ).toHaveLength(1);
  });

  it("conta SEM nenhum extrato importado não acusa nada", async () => {
    const env = createTestEnv();
    conta(env); // nenhum lote, nenhuma transação
    const t = titulo(env);
    pagamento(env, { payableId: t.id, executedAt: "2026-08-05T13:00:00.000Z" });
    recibo(env, { receivedDate: "2026-08-06" });

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: AGOSTO,
    });
    const d = res.data as ReconciliationAuditData;

    expect(d.settlementsWithoutBank).toHaveLength(0);
    expect(d.totals.pendingCoverageCount).toBe(2);
    expect(env.db.alerts).toHaveLength(0);
    expect(res.assumptions.some((a) => a.includes("conta sem extrato importado"))).toBe(true);
  });

  it("a cobertura vem do maior entre lançamento importado e data-base do saldo", async () => {
    const env = createTestEnv();
    conta(env);
    // Saldo declarado em 10/08, mas há lançamento importado até 25/08: a
    // cobertura tem de seguir o lançamento, que é mais recente.
    cobertura(env, "2026-08-10");
    transacao(env, { date: "2026-08-25", reconciled: true, amountCents: -100 });
    const t = titulo(env);
    pagamento(env, { payableId: t.id, executedAt: "2026-08-15T13:00:00.000Z" });

    const d = await auditar(env);

    expect(d.totals.pendingCoverageCount).toBe(0);
    expect(d.settlementsWithoutBank).toHaveLength(1);
  });

  it("título sem conta: só é divergência quando TODAS as contas já cobrem a data", async () => {
    const env = createTestEnv();
    conta(env);
    conta(env, { id: "ba_2", name: "Nubank", accountNumberMasked: "****9999" });
    // Uma conta coberta até 31/08, a outra sem extrato nenhum. O dinheiro pode
    // ter saído pela segunda, então não dá para acusar.
    cobertura(env, "2026-08-31", "ba_1");
    titulo(env, { paidCents: 30_000, status: "paid", updatedAt: "2026-08-05T10:00:00.000Z" });

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(0);
    expect(d.totals.pendingCoverageCount).toBe(1);
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

  it("resíduo DENTRO da tolerância não alerta — é ruído de arredondamento", async () => {
    const env = createTestEnv();
    conta(env);
    comSaldo(env, 99_950); // R$ 0,50, e a tolerância padrão é R$ 1,00

    const d = await auditar(env);

    expect(d.balanceChecks[0].residualCents).toBe(50);
    expect(d.totals.balanceMismatchCount).toBe(0);
    expect(env.db.alerts.filter((a) => a.code === "reconciliation_balance_mismatch")).toHaveLength(
      0
    );
  });

  it("resíduo acima da tolerância e até 100x dela é warning", async () => {
    const env = createTestEnv();
    conta(env);
    comSaldo(env, 95_000); // R$ 50,00: acima de R$ 1,00, abaixo de R$ 100,00

    await auditar(env);

    expect(env.db.alerts.find((a) => a.code === "reconciliation_balance_mismatch")?.severity).toBe(
      "warning"
    );
  });

  it("aritmética COM SINAL: tarifa não conciliada (−) e recebimento sem lastro (+)", async () => {
    const env = createTestEnv();
    conta(env); // saldo inicial R$ 1.000,00
    // Tarifa de R$ 120,00 no extrato, ainda não conciliada: o banco já
    // debitou, o app não conta.
    transacao(env, { amountCents: -12_000, reconciled: false, date: "2026-08-14" });
    // Recebimento de R$ 500,00 registrado no app sem transação no extrato: o
    // app soma, o banco não.
    recibo(env, { amountCents: 50_000, receivedDate: "2026-08-12" });

    // Banco: 100.000 − 12.000 = 88.000. App: 100.000 + 50.000 = 150.000.
    comSaldo(env, 88_000);

    const d = await auditar(env);
    const b = d.balanceChecks[0];

    expect(b.computedBalanceCents).toBe(150_000);
    expect(b.ledgerBalanceCents).toBe(88_000);
    expect(b.diffCents).toBe(62_000);
    // explicado = (+50.000 do recebimento) − (−12.000 da tarifa) = 62.000
    expect(b.explainedCents).toBe(62_000);
    // Os dois se somam em módulo mas têm sinais opostos na fórmula: se algum
    // sinal estivesse trocado, o resíduo seria 24.000 ou −24.000, não zero.
    expect(b.residualCents).toBe(0);
    expect(env.db.alerts.filter((a) => a.code === "reconciliation_balance_mismatch")).toHaveLength(
      0
    );
  });

  it("baixa manual de título NÃO entra no explicado", async () => {
    const env = createTestEnv();
    conta(env);
    // paidCents não participa do saldo calculado (só Payment participa), então
    // não desloca nada e não pode explicar diferença.
    titulo(env, { paidCents: 40_000, status: "paid", updatedAt: "2026-08-19T10:00:00.000Z" });
    comSaldo(env, 100_000);

    const d = await auditar(env);

    expect(d.settlementsWithoutBank).toHaveLength(1);
    expect(d.balanceChecks[0].explainedCents).toBe(0);
    expect(d.balanceChecks[0].residualCents).toBe(0);
  });
});

describe("reconciliation_audit — decomposição é POR CONTA", () => {
  it("baixa de outra conta não entra na decomposição desta", async () => {
    const env = createTestEnv();
    conta(env); // ba_1, saldo inicial R$ 1.000,00
    conta(env, {
      id: "ba_2",
      name: "Nubank",
      accountNumberMasked: "****9999",
      openingBalanceCents: 0,
    });
    cobertura(env, "2026-08-31", "ba_1");
    cobertura(env, "2026-08-31", "ba_2", 0);

    // Pagamento de R$ 300 pela conta 2, sem lastro. Ele desloca o saldo da
    // conta 2, não o da conta 1.
    const t = titulo(env);
    pagamento(env, { payableId: t.id, bankAccountId: "ba_2", amountCents: 30_000 });

    const d = await auditar(env);

    const c1 = d.balanceChecks.find((b) => b.bankAccountId === "ba_1")!;
    const c2 = d.balanceChecks.find((b) => b.bankAccountId === "ba_2")!;

    // Conta 1 não tem movimento nenhum: bate com o banco e nada a explicar.
    expect(c1.diffCents).toBe(0);
    expect(c1.explainedCents).toBe(0);
    expect(c1.residualCents).toBe(0);

    // Conta 2 é quem carrega a baixa — e o resíduo dela fecha em zero.
    expect(c2.diffCents).toBe(-30_000);
    expect(c2.explainedCents).toBe(-30_000);
    expect(c2.residualCents).toBe(0);

    expect(d.totals.balanceMismatchCount).toBe(0);
  });

  it("pendente de cobertura de outra conta também não vaza", async () => {
    const env = createTestEnv();
    conta(env);
    conta(env, {
      id: "ba_2",
      name: "Nubank",
      accountNumberMasked: "****9999",
      openingBalanceCents: 0,
    });
    // Conta 1 coberta até 31/08; conta 2 só até 05/08, então o pagamento de
    // 17/08 dela fica pendente de cobertura.
    cobertura(env, "2026-08-31", "ba_1");
    cobertura(env, "2026-08-05", "ba_2", 0);
    const t = titulo(env);
    pagamento(env, { payableId: t.id, bankAccountId: "ba_2", amountCents: 30_000 });

    const d = await auditar(env);

    expect(d.totals.pendingCoverageCount).toBe(1);
    const c1 = d.balanceChecks.find((b) => b.bankAccountId === "ba_1")!;
    expect(c1.explainedCents).toBe(0);
    expect(c1.residualCents).toBe(0);
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

  it("declara quantas baixas manuais ficaram fora do filtro de conta", async () => {
    const env = createTestEnv();
    conta(env);
    conta(env, { id: "ba_2", name: "Nubank", accountNumberMasked: "****9999" });
    titulo(env, { paidCents: 30_000, status: "paid", updatedAt: "2026-08-19T10:00:00.000Z" });
    titulo(env, { paidCents: 10_000, status: "paid", updatedAt: "2026-08-20T10:00:00.000Z" });

    const res = await runSkill(conciliacaoSkill, env.ctx(env.actorFor("analyst")), {
      action: "reconciliation_audit",
      period: AGOSTO,
      bankAccountId: "ba_1",
    });
    const d = res.data as ReconciliationAuditData;

    // O título não tem conta bancária: não dá para atribuí-lo ao filtro.
    expect(d.settlementsWithoutBank).toHaveLength(0);
    expect(res.assumptions.some((a) => a.includes("2 baixa(s) manual(is)"))).toBe(true);
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
    cobertura(env);
    const t = titulo(env);
    pagamento(env, { payableId: t.id });

    await auditar(env);

    const ev = env.db.events.filter((e) => e.type === "reconciliation.audited");
    expect(ev).toHaveLength(1);
    expect((ev[0].payload as { totals: { settlementsWithoutBankCount: number } }).totals
      .settlementsWithoutBankCount).toBe(1);
  });
});
