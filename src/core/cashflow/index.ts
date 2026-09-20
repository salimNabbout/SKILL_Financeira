/**
 * Serviço de domínio do Fluxo de Caixa: unificação + regras de cálculo, sem
 * banco nem framework. `computeCashflow` é a porta única para a skill/API.
 */

import type { CashflowCategory, CashflowEntry, CashflowParameter, CashflowScenario } from "@/core/entities";
import { computeAlerts, type CashflowAlert } from "./alerts";
import { computeMonthly, computeVariance, type MonthlyStatement, type VarianceStatement } from "./calc";
import { computeProjection, type ProjectionResult } from "./projection";

export interface CashflowComputeInput {
  year: number;
  entries: CashflowEntry[];
  categories: CashflowCategory[];
  parameter: Pick<CashflowParameter, "openingBalanceCents" | "minimumReserveCents" | "realizedMonthsOverride">;
  scenarios: CashflowScenario[];
}

export interface CashflowComputeOutput {
  monthly: MonthlyStatement;
  variance: VarianceStatement;
  projection: ProjectionResult;
  alerts: CashflowAlert[];
}

export function computeCashflow(input: CashflowComputeInput): CashflowComputeOutput {
  const monthly = computeMonthly({
    year: input.year,
    entries: input.entries,
    categories: input.categories,
    openingBalanceCents: input.parameter.openingBalanceCents,
    minimumReserveCents: input.parameter.minimumReserveCents,
  });
  const variance = computeVariance({ year: input.year, entries: input.entries, categories: input.categories });
  const projection = computeProjection({
    year: input.year,
    entries: input.entries,
    openingBalanceCents: input.parameter.openingBalanceCents,
    minimumReserveCents: input.parameter.minimumReserveCents,
    realizedMonthsOverride: input.parameter.realizedMonthsOverride,
    scenarios: input.scenarios,
  });
  const alerts = computeAlerts({ year: input.year, entries: input.entries, categories: input.categories, monthly, projection });
  return { monthly, variance, projection, alerts };
}

export * from "./plan";
export * from "./unify";
export * from "./calc";
export * from "./projection";
export * from "./alerts";
export * from "./import";
