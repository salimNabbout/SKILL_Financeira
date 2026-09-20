/**
 * Alertas acionáveis do Fluxo de Caixa (aba "Dashboard"). Estruturados e
 * específicos: cada texto cita mês e valores — nunca "reduza despesas".
 *
 *  - reserva_realista:        primeiro mês projetado com saldo abaixo da
 *                             reserva mínima no cenário realista;
 *  - negativo_pessimista:     primeiro mês projetado com caixa negativo no
 *                             cenário pessimista;
 *  - crescimento_categoria:   categoria de saída cujo REALIZADO num mês supera
 *                             em mais de 15% a média dos meses anteriores com
 *                             movimento realizado no ano base;
 *  - concentracao_categoria:  categoria com mais de 30% do total de saídas do
 *                             ano base (grade Fluxo Mensal: previsto + realizado).
 */

import type { CashflowCategory, CashflowEntry } from "@/core/entities";
import { formatBRL } from "@/core/money";
import { monthLabel, type MonthlyStatement } from "./calc";
import type { ProjectionResult } from "./projection";

export type CashflowAlertCode =
  | "reserva_realista"
  | "negativo_pessimista"
  | "crescimento_categoria"
  | "concentracao_categoria";

export interface CashflowAlert {
  code: CashflowAlertCode;
  severity: "info" | "warning" | "critical";
  /** Mês a que o alerta se refere ("YYYY-MM"), quando houver. */
  month?: string;
  categoryId?: string;
  text: string;
  /** Números que sustentam o texto, para a UI e para testes. */
  values: Record<string, number>;
}

export interface AlertsInput {
  year: number;
  entries: CashflowEntry[];
  categories: CashflowCategory[];
  monthly: MonthlyStatement;
  projection: ProjectionResult;
}

/** Limiar de crescimento de categoria (15%) e de concentração (30%), em pontos-base. */
export const GROWTH_THRESHOLD_BP = 1500;
export const CONCENTRATION_THRESHOLD_BP = 3000;

export function computeAlerts(input: AlertsInput): CashflowAlert[] {
  const alerts: CashflowAlert[] = [];
  const reserve = input.monthly.minimumReserveCents;

  const realista = input.projection.scenarios.find((s) => s.code === "realista");
  if (realista?.firstBelowReserve) {
    const f = realista.firstBelowReserve;
    alerts.push({
      code: "reserva_realista",
      severity: "warning",
      month: f.month,
      text: `Cenário realista: saldo projetado cai abaixo da reserva mínima (${formatBRL(reserve)}) em ${monthLabel(f.month)}, com ${formatBRL(f.balanceCents)}.`,
      values: { balanceCents: f.balanceCents, reserveCents: reserve, monthIndex: f.index },
    });
  }

  const pessimista = input.projection.scenarios.find((s) => s.code === "pessimista");
  if (pessimista?.firstNegative) {
    const f = pessimista.firstNegative;
    alerts.push({
      code: "negativo_pessimista",
      severity: "critical",
      month: f.month,
      text: `Cenário pessimista: caixa fica negativo em ${monthLabel(f.month)} (saldo projetado ${formatBRL(f.balanceCents)}); ${pessimista.monthsNegative} mês(es) negativo(s) e ${pessimista.monthsBelowReserve} abaixo da reserva nos 12 meses.`,
      values: { balanceCents: f.balanceCents, monthIndex: f.index, monthsNegative: pessimista.monthsNegative, monthsBelowReserve: pessimista.monthsBelowReserve },
    });
  }

  // Crescimento de categoria de saída: realizado do mês × média dos meses
  // anteriores com realizado (> 0) da mesma categoria, no ano base.
  const byCategory = new Map<string, number[]>();
  for (const e of input.entries) {
    if (e.year !== input.year || e.status !== "realizado" || e.kind !== "saida") continue;
    const series = byCategory.get(e.categoryId) ?? Array.from({ length: 12 }, () => 0);
    series[e.month - 1] += e.amountCents;
    byCategory.set(e.categoryId, series);
  }
  const nameOf = new Map(input.categories.map((c) => [c.id, c.name]));
  for (const [categoryId, series] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const kindOk = input.categories.find((c) => c.id === categoryId)?.kind === "saida";
    if (!kindOk) continue;
    for (let m = 1; m < 12; m++) {
      const current = series[m];
      if (current <= 0) continue;
      const previous = series.slice(0, m).filter((v) => v > 0);
      if (previous.length === 0) continue;
      const avgCents = Math.round(previous.reduce((a, b) => a + b, 0) / previous.length);
      if (avgCents <= 0) continue;
      // crescimento > 15%  ⇔  current × 10000 > avg × (10000 + 1500), em inteiros
      if (current * 10_000 > avgCents * (10_000 + GROWTH_THRESHOLD_BP)) {
        const growthBp = Math.round(((current - avgCents) * 10_000) / avgCents);
        const month = `${input.year}-${String(m + 1).padStart(2, "0")}`;
        alerts.push({
          code: "crescimento_categoria",
          severity: "warning",
          month,
          categoryId,
          text: `${nameOf.get(categoryId) ?? categoryId}: ${formatBRL(current)} realizados em ${monthLabel(month)}, ${pct(growthBp)} acima da média dos meses anteriores (${formatBRL(avgCents)}).`,
          values: { currentCents: current, averageCents: avgCents, growthBp, previousMonths: previous.length },
        });
      }
    }
  }

  // Concentração: categoria de saída com mais de 30% do total de saídas do ano.
  const totalSaidas = input.monthly.saidasAnoCents;
  if (totalSaidas > 0) {
    for (const row of input.monthly.rows) {
      if (row.kind !== "saida" || row.totalCents <= 0) continue;
      if (row.totalCents * 10_000 > totalSaidas * CONCENTRATION_THRESHOLD_BP) {
        const shareBp = Math.round((row.totalCents * 10_000) / totalSaidas);
        alerts.push({
          code: "concentracao_categoria",
          severity: "info",
          categoryId: row.categoryId,
          text: `${row.name} concentra ${pct(shareBp)} das saídas do ano (${formatBRL(row.totalCents)} de ${formatBRL(totalSaidas)}).`,
          values: { categoryCents: row.totalCents, totalCents: totalSaidas, shareBp },
        });
      }
    }
  }

  return alerts;
}

/** 5890 bp → "58,9%". */
function pct(bp: number): string {
  return `${(bp / 100).toFixed(1).replace(".", ",")}%`;
}
