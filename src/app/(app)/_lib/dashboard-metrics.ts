/**
 * Cálculos que o Dashboard faz por conta própria sobre a série diária da
 * projeção (tesouraria_fluxo_caixa / refresh_projection). Funções puras,
 * separadas da página para serem testáveis — a página apenas as compõe.
 *
 * Fórmulas (documentadas em DASHBOARD_FORMULAS e em docs/relatorio-formulas.md):
 * - A pagar (7 dias)   = Σ outCents dos pontos diários com data ≤ hoje + 7
 * - A receber (7 dias) = Σ inCents dos pontos diários com data ≤ hoje + 7
 * - Gráfico 4 semanas  = semana k (k = 0..3) soma os pontos com data em
 *                        [hoje + 7k, hoje + 7k + 6]
 * A série diária começa em "hoje" e já traz os títulos vencidos consolidados
 * nessa data (regra da skill), então "≤ hoje + 7" cobre hoje..hoje+7 (8 dias
 * corridos, ambas as pontas inclusivas) — o rodapé do card mostra o limite.
 */

import { addDays, formatBR, type ISODate } from "@/core/dates";
import type { InOutGroup } from "./charts";

/** Forma defensiva do ponto diário devolvido pela skill (tudo opcional). */
export interface DailyPointView {
  date?: ISODate;
  inCents?: number;
  outCents?: number;
  balanceCents?: number;
}

export const DASHBOARD_FORMULAS = {
  payables7d:
    "A pagar (7 dias) = Σ outCents da série diária da projeção com data ≤ hoje + 7 (inclusivo); vencidos entram em hoje",
  receivables7d:
    "A receber (7 dias) = Σ inCents da série diária da projeção com data ≤ hoje + 7 (inclusivo); vencidos entram em hoje",
  weeks4:
    "Gráfico 4 semanas: semana k (k = 0..3) = Σ inCents / Σ outCents dos pontos com data em [hoje + 7k, hoje + 7k + 6]",
} as const;

export interface FlowsThrough {
  inCents: number;
  outCents: number;
  /** Último dia incluído na janela (hoje + 7). */
  limit: ISODate;
}

function hasDate(d: DailyPointView | undefined): d is DailyPointView & { date: ISODate } {
  return typeof d?.date === "string";
}

/** Entradas e saídas previstas de hoje até hoje + 7, ambas as pontas inclusivas. */
export function sumFlowsThrough(daily: DailyPointView[], today: ISODate): FlowsThrough {
  const limit = addDays(today, 7);
  let inCents = 0;
  let outCents = 0;
  for (const d of daily) {
    if (!hasDate(d) || d.date > limit) continue;
    inCents += d.inCents ?? 0;
    outCents += d.outCents ?? 0;
  }
  return { inCents, outCents, limit };
}

/** Quatro semanas de 7 dias a partir de hoje, cada uma com Σ entradas e Σ saídas. */
export function buildWeekGroups(
  daily: DailyPointView[],
  today: ISODate,
  weeks = 4
): InOutGroup[] {
  const groups: InOutGroup[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(today, w * 7);
    const end = addDays(today, w * 7 + 6);
    let inCents = 0;
    let outCents = 0;
    for (const d of daily) {
      if (!hasDate(d) || d.date < start || d.date > end) continue;
      inCents += d.inCents ?? 0;
      outCents += d.outCents ?? 0;
    }
    groups.push({
      label: `Sem ${w + 1}`,
      title: `${formatBR(start)} a ${formatBR(end)}`,
      inCents,
      outCents,
    });
  }
  return groups;
}

export type AvailableTone = "neutral" | "crit" | "warn" | "ok";

/** Tom do card: negativo é crítico; abaixo do caixa mínimo é atenção. */
export function availableTone(
  availableCents: number | undefined,
  minimumCashCents: number
): AvailableTone {
  if (typeof availableCents !== "number") return "neutral";
  if (availableCents < 0) return "crit";
  if (availableCents < minimumCashCents) return "warn";
  return "ok";
}
