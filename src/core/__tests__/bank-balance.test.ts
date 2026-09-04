/**
 * Saldo do período: a fórmula é simples, mas o que ela EXCLUI é o que importa.
 */

import { describe, expect, it } from "vitest";
import { computeBankPeriodBalance, reconciledInPeriod } from "../bank-balance";
import type { BankTransaction } from "../entities";

const CONTA = { id: "bnk_1", openingBalanceCents: 100_000 }; // R$ 1.000,00
const PERIODO = { from: "2026-09-01" as const, to: "2026-09-30" as const };

function tx(over: Partial<BankTransaction> & { amountCents: number }): BankTransaction {
  return {
    id: `btx_${Math.random().toString(36).slice(2, 8)}`,
    companyId: "co_1",
    bankAccountId: "bnk_1",
    date: "2026-09-15",
    currency: "BRL",
    description: "lançamento",
    source: "ofx",
    reconciled: true,
    createdAt: "2026-09-15T12:00:00.000Z",
    ...over,
  };
}

describe("computeBankPeriodBalance", () => {
  it("sem lançamentos no período, o saldo é o saldo inicial", () => {
    const r = computeBankPeriodBalance(CONTA, [], PERIODO);

    expect(r.balanceCents).toBe(100_000);
    expect(r.openingBalanceCents).toBe(100_000);
    expect(r.inflowCents).toBe(0);
    expect(r.outflowCents).toBe(0);
    expect(r.reconciledCount).toBe(0);
  });

  it("saldo = inicial + entradas − saídas, com os totais em módulo", () => {
    const r = computeBankPeriodBalance(
      CONTA,
      [tx({ amountCents: 50_000 }), tx({ amountCents: 30_000 }), tx({ amountCents: -20_000 })],
      PERIODO
    );

    expect(r.inflowCents).toBe(80_000);
    expect(r.inflowCount).toBe(2);
    // O valor gravado é negativo; o total sai positivo.
    expect(r.outflowCents).toBe(20_000);
    expect(r.outflowCount).toBe(1);
    expect(r.balanceCents).toBe(100_000 + 80_000 - 20_000);
    expect(r.reconciledCount).toBe(3);
  });

  it("os limites do período são inclusivos nas duas pontas", () => {
    const r = computeBankPeriodBalance(
      CONTA,
      [
        tx({ amountCents: 1_000, date: "2026-08-31" }), // véspera: fora
        tx({ amountCents: 2_000, date: "2026-09-01" }), // primeiro dia: dentro
        tx({ amountCents: 4_000, date: "2026-09-30" }), // último dia: dentro
        tx({ amountCents: 8_000, date: "2026-10-01" }), // dia seguinte: fora
      ],
      PERIODO
    );

    expect(r.inflowCents).toBe(6_000);
    expect(r.inflowCount).toBe(2);
  });

  it("lançamento não conciliado é ignorado", () => {
    const r = computeBankPeriodBalance(
      CONTA,
      [tx({ amountCents: 70_000, reconciled: false }), tx({ amountCents: 5_000 })],
      PERIODO
    );

    expect(r.inflowCents).toBe(5_000);
    expect(r.reconciledCount).toBe(1);
    expect(r.balanceCents).toBe(105_000);
  });

  it("transação de outra conta não vaza para o total", () => {
    const r = computeBankPeriodBalance(
      CONTA,
      [tx({ amountCents: 90_000, bankAccountId: "bnk_2" }), tx({ amountCents: -1_000 })],
      PERIODO
    );

    expect(r.inflowCents).toBe(0);
    expect(r.outflowCents).toBe(1_000);
    expect(r.balanceCents).toBe(99_000);
  });

  it("valor zero não conta como entrada nem como saída", () => {
    const r = computeBankPeriodBalance(CONTA, [tx({ amountCents: 0 })], PERIODO);

    expect(r.inflowCount).toBe(0);
    expect(r.outflowCount).toBe(0);
    expect(r.reconciledCount).toBe(0);
    expect(r.balanceCents).toBe(100_000);
  });

  it("saldo fica negativo quando as saídas superam inicial + entradas", () => {
    const r = computeBankPeriodBalance(
      CONTA,
      [tx({ amountCents: 10_000 }), tx({ amountCents: -150_000 })],
      PERIODO
    );

    expect(r.balanceCents).toBe(-40_000);
    // O total de saídas continua positivo: o sinal é da fórmula, não do total.
    expect(r.outflowCents).toBe(150_000);
  });

  it("período de um único dia inclui o que caiu nele", () => {
    const r = computeBankPeriodBalance(
      CONTA,
      [tx({ amountCents: 3_000, date: "2026-09-10" }), tx({ amountCents: 9_000, date: "2026-09-11" })],
      { from: "2026-09-10", to: "2026-09-10" }
    );

    expect(r.inflowCents).toBe(3_000);
    expect(r.reconciledCount).toBe(1);
  });
});

describe("reconciledInPeriod", () => {
  const MISTURA = [
    tx({ amountCents: 5_000, date: "2026-09-10" }),
    tx({ amountCents: -2_000, date: "2026-09-02" }),
    tx({ amountCents: 9_000, date: "2026-08-31" }), // fora do período
    tx({ amountCents: 7_000, reconciled: false }), // não conciliada
    tx({ amountCents: 3_000, bankAccountId: "bnk_2" }), // outra conta
  ];

  it("devolve só o que entra na conta do saldo, ordenado por data", () => {
    const linhas = reconciledInPeriod(CONTA.id, MISTURA, PERIODO);

    expect(linhas.map((t) => t.date)).toEqual(["2026-09-02", "2026-09-10"]);
  });

  it("a lista SEMPRE soma o total da caixa — é o mesmo filtro", () => {
    const linhas = reconciledInPeriod(CONTA.id, MISTURA, PERIODO);
    const saldo = computeBankPeriodBalance(CONTA, MISTURA, PERIODO);

    const entradas = linhas.filter((t) => t.amountCents > 0);
    const saidas = linhas.filter((t) => t.amountCents < 0);

    expect(entradas.reduce((a, t) => a + t.amountCents, 0)).toBe(saldo.inflowCents);
    expect(saidas.reduce((a, t) => a + Math.abs(t.amountCents), 0)).toBe(saldo.outflowCents);
    expect(linhas.length).toBe(saldo.reconciledCount);
  });

  it("lançamento de valor zero aparece na lista mas não conta como lançamento", () => {
    const comZero = [...MISTURA, tx({ amountCents: 0, date: "2026-09-05" })];
    const linhas = reconciledInPeriod(CONTA.id, comZero, PERIODO);
    const saldo = computeBankPeriodBalance(CONTA, comZero, PERIODO);

    // A divergência é conhecida e proposital: zero não é entrada nem saída.
    expect(linhas.length).toBe(3);
    expect(saldo.reconciledCount).toBe(2);
  });
});
