/**
 * Saldo do período. A fórmula é trivial; o que importa é o que ela EXCLUI —
 * e, principalmente, o que ela se recusa a contar duas vezes.
 */

import { describe, expect, it } from "vitest";
import { balanceLines, computeBankPeriodBalance, type BankBalanceInput } from "../bank-balance";
import type { BankTransaction, Payment, Receipt, ReconciliationMatch } from "../entities";

const CONTA = { id: "bnk_1", openingBalanceCents: 100_000 }; // R$ 1.000,00
const PERIODO = { from: "2026-09-01" as const, to: "2026-09-30" as const };
const TZ = "America/Sao_Paulo";

function pagamento(over: Partial<Payment> & { amountCents: number }): Payment {
  return {
    id: `pay_${Math.random().toString(36).slice(2, 8)}`,
    companyId: "co_1",
    payableId: "payb_1",
    bankAccountId: "bnk_1",
    scheduledDate: "2026-09-15",
    executedAt: "2026-09-15T18:00:00.000Z",
    status: "executed",
    requestedBy: "usr_1",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-15T18:00:00.000Z",
    ...over,
  };
}

function recibo(over: Partial<Receipt> & { amountCents: number }): Receipt {
  return {
    id: `rcp_${Math.random().toString(36).slice(2, 8)}`,
    companyId: "co_1",
    receivableId: "recv_1",
    bankAccountId: "bnk_1",
    receivedDate: "2026-09-10",
    method: "pix",
    registeredBy: "usr_1",
    createdAt: "2026-09-10T12:00:00.000Z",
    ...over,
  };
}

function transacao(over: Partial<BankTransaction> & { amountCents: number }): BankTransaction {
  return {
    id: `btx_${Math.random().toString(36).slice(2, 8)}`,
    companyId: "co_1",
    bankAccountId: "bnk_1",
    date: "2026-09-12",
    currency: "BRL",
    description: "lançamento",
    source: "ofx",
    reconciled: true,
    createdAt: "2026-09-12T12:00:00.000Z",
    ...over,
  };
}

function match(
  over: Partial<ReconciliationMatch> & { bankTransactionId: string }
): ReconciliationMatch {
  return {
    id: `mtc_${Math.random().toString(36).slice(2, 8)}`,
    companyId: "co_1",
    targetType: "payment",
    confidence: 1,
    status: "confirmed",
    matchedBy: "usr_1",
    createdAt: "2026-09-12T12:00:00.000Z",
    updatedAt: "2026-09-12T12:00:00.000Z",
    ...over,
  };
}

function entrada(over: Partial<BankBalanceInput> = {}): BankBalanceInput {
  return {
    account: CONTA,
    payments: [],
    receipts: [],
    transactions: [],
    matches: [],
    period: PERIODO,
    timeZone: TZ,
    ...over,
  };
}

describe("computeBankPeriodBalance", () => {
  it("sem movimentação, o saldo é o saldo inicial", () => {
    const r = computeBankPeriodBalance(entrada());

    expect(r.balanceCents).toBe(100_000);
    expect(r.inflowCents).toBe(0);
    expect(r.outflowCents).toBe(0);
    expect(r.reconciledCount).toBe(0);
  });

  it("pagamento executado é SAÍDA — o caso que a versão anterior não via", () => {
    const r = computeBankPeriodBalance(entrada({ payments: [pagamento({ amountCents: 30_000 })] }));

    expect(r.outflowCents).toBe(30_000);
    expect(r.outflowCount).toBe(1);
    expect(r.balanceCents).toBe(70_000);
  });

  it("recebimento é ENTRADA, pelo valor que caiu no banco", () => {
    const r = computeBankPeriodBalance(
      // amountCents inclui multa/juros; principalCents só baixa o título.
      entrada({ receipts: [recibo({ amountCents: 25_000, principalCents: 20_000 })] })
    );

    expect(r.inflowCents).toBe(25_000);
    expect(r.balanceCents).toBe(125_000);
  });

  it("pagamento não executado, estornado ou de outra conta fica de fora", () => {
    const r = computeBankPeriodBalance(
      entrada({
        payments: [
          pagamento({ amountCents: 10_000, status: "approved", executedAt: undefined }),
          pagamento({ amountCents: 20_000, status: "canceled" }), // estornado
          pagamento({ amountCents: 40_000, bankAccountId: "bnk_2" }),
        ],
      })
    );

    expect(r.outflowCents).toBe(0);
    expect(r.balanceCents).toBe(100_000);
  });

  it("recibo cancelado não conta", () => {
    const r = computeBankPeriodBalance(
      entrada({ receipts: [recibo({ amountCents: 50_000, status: "canceled" })] })
    );

    expect(r.inflowCents).toBe(0);
  });

  it("recibo sem conta bancária não é atribuível e fica de fora", () => {
    const r = computeBankPeriodBalance(
      entrada({ receipts: [recibo({ amountCents: 50_000, bankAccountId: undefined })] })
    );

    expect(r.inflowCents).toBe(0);
  });

  it("transação do extrato SEM correspondência entra — é a tarifa que ninguém mais vê", () => {
    const r = computeBankPeriodBalance(
      entrada({ transactions: [transacao({ amountCents: -1_500, description: "TARIFA" })] })
    );

    expect(r.outflowCents).toBe(1_500);
    expect(r.balanceCents).toBe(98_500);
  });

  it("NÃO conta duas vezes: transação casada com pagamento entra só uma vez", () => {
    const pag = pagamento({ amountCents: 30_000 });
    const tx = transacao({ amountCents: -30_000 });

    const r = computeBankPeriodBalance(
      entrada({
        payments: [pag],
        transactions: [tx],
        matches: [match({ bankTransactionId: tx.id, targetType: "payment", targetId: pag.id })],
      })
    );

    expect(r.outflowCents).toBe(30_000);
    expect(r.outflowCount).toBe(1);
    expect(r.balanceCents).toBe(70_000);
  });

  it("match rejeitado não deduplica nada: a transação segue contando", () => {
    const tx = transacao({ amountCents: -2_000 });
    const r = computeBankPeriodBalance(
      entrada({
        transactions: [tx],
        matches: [match({ bankTransactionId: tx.id, status: "rejected" })],
      })
    );

    expect(r.outflowCents).toBe(2_000);
  });

  it("transação casada como bank_fee entra: não há pagamento do outro lado", () => {
    const tx = transacao({ amountCents: -900 });
    const r = computeBankPeriodBalance(
      entrada({
        transactions: [tx],
        matches: [match({ bankTransactionId: tx.id, targetType: "bank_fee" })],
      })
    );

    expect(r.outflowCents).toBe(900);
  });

  it("transação do extrato não conciliada fica de fora", () => {
    const r = computeBankPeriodBalance(
      entrada({ transactions: [transacao({ amountCents: -7_000, reconciled: false })] })
    );

    expect(r.outflowCents).toBe(0);
  });

  it("limites do período são inclusivos nas duas pontas", () => {
    const r = computeBankPeriodBalance(
      entrada({
        receipts: [
          recibo({ amountCents: 1_000, receivedDate: "2026-08-31" }), // fora
          recibo({ amountCents: 2_000, receivedDate: "2026-09-01" }), // dentro
          recibo({ amountCents: 4_000, receivedDate: "2026-09-30" }), // dentro
          recibo({ amountCents: 8_000, receivedDate: "2026-10-01" }), // fora
        ],
      })
    );

    expect(r.inflowCents).toBe(6_000);
    expect(r.inflowCount).toBe(2);
  });

  it("pagamento do fim da tarde não pula de dia: a data é a do fuso da empresa", () => {
    // 30/09 22:00 em São Paulo = 01/10 01:00 UTC. Em UTC, cairia fora.
    const noite = pagamento({ amountCents: 5_000, executedAt: "2026-10-01T01:00:00.000Z" });

    expect(computeBankPeriodBalance(entrada({ payments: [noite] })).outflowCents).toBe(5_000);
  });

  it("saldo fica negativo quando as saídas superam inicial + entradas", () => {
    const r = computeBankPeriodBalance(entrada({ payments: [pagamento({ amountCents: 150_000 })] }));

    expect(r.balanceCents).toBe(-50_000);
    // O total de saídas continua positivo: o sinal é da fórmula.
    expect(r.outflowCents).toBe(150_000);
  });
});

describe("balanceLines", () => {
  const COMPLETO = entrada({
    payments: [pagamento({ amountCents: 30_000, executedAt: "2026-09-15T18:00:00.000Z" })],
    receipts: [recibo({ amountCents: 12_000, receivedDate: "2026-09-10" })],
    transactions: [transacao({ amountCents: -1_500, date: "2026-09-12" })],
  });

  it("a lista SEMPRE soma o total da caixa — os totais derivam dela", () => {
    const linhas = balanceLines(COMPLETO);
    const saldo = computeBankPeriodBalance(COMPLETO);

    const entradas = linhas.filter((l) => l.amountCents > 0);
    const saidas = linhas.filter((l) => l.amountCents < 0);

    expect(entradas.reduce((a, l) => a + l.amountCents, 0)).toBe(saldo.inflowCents);
    expect(saidas.reduce((a, l) => a + Math.abs(l.amountCents), 0)).toBe(saldo.outflowCents);
    expect(linhas.length).toBe(saldo.reconciledCount);
  });

  it("junta as três origens, ordenadas por data", () => {
    const linhas = balanceLines(COMPLETO);

    expect(linhas.map((l) => [l.date, l.origin])).toEqual([
      ["2026-09-10", "receipt"],
      ["2026-09-12", "bank"],
      ["2026-09-15", "payment"],
    ]);
  });

  it("pagamento entra com sinal negativo, recebimento com positivo", () => {
    const linhas = balanceLines(COMPLETO);

    expect(linhas.find((l) => l.origin === "payment")?.amountCents).toBe(-30_000);
    expect(linhas.find((l) => l.origin === "receipt")?.amountCents).toBe(12_000);
  });
});
