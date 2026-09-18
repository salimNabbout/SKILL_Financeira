/**
 * Aba "Projeção" da planilha "Fluxo de Caixa CETEM", como domínio puro.
 *
 *  - Meses realizados   = nº de meses distintos do ano base com ao menos um
 *                         movimento realizado; sobrescrito pelo override.
 *  - Média de entradas  = entradas realizadas no ano ÷ meses realizados
 *                         (idem saídas). Meses realizados = 0 → média zero e
 *                         aviso, sem dividir.
 *  - Saldo de partida   = saldo inicial + entradas realizadas − saídas realizadas.
 *  - Mês i (0..11), por cenário:
 *      entradas_i = média_entradas × (1 + ajuste_receita) × (1 + crescimento)^i
 *      saidas_i   = média_saídas   × (1 + ajuste_despesa) × (1 + crescimento)^i
 *      resultado_i = entradas_i − saidas_i
 *      saldo_i = (i = 0 ? saldo_partida : saldo_(i−1)) + resultado_i
 *  - Meses abaixo da reserva = #{saldo_i < reserva}; caixa negativo = #{saldo_i < 0};
 *    saldo em 12 meses = saldo_11.
 *  - Menos de 3 meses realizados → `lowConfidence = true`.
 *
 * As frações são exatas (BigInt) e só viram centavos na saída, uma vez —
 * a planilha faz o mesmo (arredonda na célula, não no cálculo).
 *
 * Os 12 meses projetados começam no mês seguinte ao último com movimento
 * realizado no ano base (sem realizado: janeiro do ano base).
 */

import { addMonths, type ISOMonth } from "@/core/dates";
import type { CashflowEntry, CashflowScenario, CashflowScenarioCode } from "@/core/entities";
import { add, bpFactor, cmp, fromCents, mul, pow, rat, sub, toCents, type Rational } from "./rational";

export interface ProjectionInput {
  year: number;
  entries: CashflowEntry[];
  openingBalanceCents: number;
  minimumReserveCents: number;
  realizedMonthsOverride?: number;
  scenarios: CashflowScenario[];
}

export interface ProjectedMonth {
  month: ISOMonth;
  inCents: number;
  outCents: number;
  resultCents: number;
  balanceCents: number;
}

export interface ScenarioProjection {
  code: CashflowScenarioCode;
  name: string;
  revenueAdjustmentBp: number;
  expenseAdjustmentBp: number;
  monthlyGrowthBp: number;
  months: ProjectedMonth[];
  monthsBelowReserve: number;
  monthsNegative: number;
  /** Índice (0..11) e mês do primeiro saldo abaixo da reserva / negativo, se houver. */
  firstBelowReserve?: { index: number; month: ISOMonth; balanceCents: number };
  firstNegative?: { index: number; month: ISOMonth; balanceCents: number };
  balance12Cents: number;
}

export interface ProjectionResult {
  year: number;
  realizedMonths: number;
  realizedMonthsSource: "calculado" | "override";
  realizedInCents: number;
  realizedOutCents: number;
  /** Médias arredondadas para exibição; o cálculo usa as frações exatas. */
  avgInCents: number;
  avgOutCents: number;
  startingBalanceCents: number;
  startMonth: ISOMonth;
  lowConfidence: boolean;
  warnings: string[];
  scenarios: ScenarioProjection[];
}

export function computeProjection(input: ProjectionInput): ProjectionResult {
  const realized = input.entries.filter((e) => e.year === input.year && e.status === "realizado");
  const monthsWithMovement = new Set(realized.map((e) => e.month));
  const realizedMonths =
    input.realizedMonthsOverride != null && input.realizedMonthsOverride >= 0
      ? input.realizedMonthsOverride
      : monthsWithMovement.size;
  const realizedInCents = realized.filter((e) => e.kind === "entrada").reduce((a, e) => a + e.amountCents, 0);
  const realizedOutCents = realized.filter((e) => e.kind === "saida").reduce((a, e) => a + e.amountCents, 0);

  const warnings: string[] = [];
  const avgIn: Rational = realizedMonths > 0 ? rat(BigInt(realizedInCents), BigInt(realizedMonths)) : fromCents(0);
  const avgOut: Rational = realizedMonths > 0 ? rat(BigInt(realizedOutCents), BigInt(realizedMonths)) : fromCents(0);
  if (realizedMonths === 0) {
    warnings.push("Nenhum mês realizado no ano base: médias zeradas, projeção sem base histórica.");
  }
  const lowConfidence = realizedMonths < 3;
  if (lowConfidence && realizedMonths > 0) {
    warnings.push(`Apenas ${realizedMonths} mês(es) realizado(s): projeção de baixa confiabilidade.`);
  }

  const startingBalanceCents = input.openingBalanceCents + realizedInCents - realizedOutCents;
  const lastRealizedMonth = monthsWithMovement.size > 0 ? Math.max(...monthsWithMovement) : 0;
  const startMonth: ISOMonth =
    lastRealizedMonth === 0
      ? `${input.year}-01`
      : addMonths(`${input.year}-${String(lastRealizedMonth).padStart(2, "0")}-01`, 1).slice(0, 7);

  const reserve = fromCents(input.minimumReserveCents);
  const zero = fromCents(0);
  const start = fromCents(startingBalanceCents);

  const scenarios = [...input.scenarios]
    .filter((s) => s.active)
    .sort((a, b) => ORDER[a.code] - ORDER[b.code])
    .map<ScenarioProjection>((s) => {
      const growth = bpFactor(s.monthlyGrowthBp);
      const inBase = mul(avgIn, bpFactor(s.revenueAdjustmentBp));
      const outBase = mul(avgOut, bpFactor(s.expenseAdjustmentBp));
      let balance = start;
      let belowReserve = 0;
      let negative = 0;
      let firstBelowReserve: ScenarioProjection["firstBelowReserve"];
      let firstNegative: ScenarioProjection["firstNegative"];
      const months: ProjectedMonth[] = [];
      for (let i = 0; i < 12; i++) {
        const factor = pow(growth, i);
        const entradas = mul(inBase, factor);
        const saidas = mul(outBase, factor);
        const resultado = sub(entradas, saidas);
        balance = add(balance, resultado);
        const month = addMonths(`${startMonth}-01`, i).slice(0, 7);
        const balanceCents = toCents(balance);
        if (cmp(balance, reserve) < 0) {
          belowReserve += 1;
          firstBelowReserve ??= { index: i, month, balanceCents };
        }
        if (cmp(balance, zero) < 0) {
          negative += 1;
          firstNegative ??= { index: i, month, balanceCents };
        }
        months.push({
          month,
          inCents: toCents(entradas),
          outCents: toCents(saidas),
          resultCents: toCents(resultado),
          balanceCents,
        });
      }
      return {
        code: s.code,
        name: s.name,
        revenueAdjustmentBp: s.revenueAdjustmentBp,
        expenseAdjustmentBp: s.expenseAdjustmentBp,
        monthlyGrowthBp: s.monthlyGrowthBp,
        months,
        monthsBelowReserve: belowReserve,
        monthsNegative: negative,
        firstBelowReserve,
        firstNegative,
        balance12Cents: months[11]?.balanceCents ?? startingBalanceCents,
      };
    });

  return {
    year: input.year,
    realizedMonths,
    realizedMonthsSource: input.realizedMonthsOverride != null ? "override" : "calculado",
    realizedInCents,
    realizedOutCents,
    avgInCents: toCents(avgIn),
    avgOutCents: toCents(avgOut),
    startingBalanceCents,
    startMonth,
    lowConfidence,
    warnings,
    scenarios,
  };
}

const ORDER: Record<CashflowScenarioCode, number> = { otimista: 0, realista: 1, pessimista: 2 };
