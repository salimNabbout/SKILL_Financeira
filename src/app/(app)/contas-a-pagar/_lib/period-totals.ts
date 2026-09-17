/**
 * Totalizadores do bloco Filtros de Contas a pagar: "Total Pago no Período",
 * "Total de Custo FIXO" e "Total de Custo VARIÁVEL". Funções puras.
 *
 * Período = VENCIMENTO. A referência é sempre um MÊS completo (calendário
 * oficial: 28/29/30/31 dias): o selecionado na caixa "Mês" (no ano da caixa
 * "Ano", ou no ano corrente) ou, sem seleção, o mês corrente. Só quando as
 * caixas "De (vencimento)" e "Até (vencimento)" estão preenchidas o período
 * passa a ser exatamente o delas. Só "De": até o fim do mês da data; só
 * "Até": desde o início do mês da data.
 *
 * Fórmulas:
 * - Total Pago no Período   = Σ paidCents dos títulos com dueDate em [de, até] e status ≠ canceled
 * - Total de Custo FIXO     = parcela com costClassification = fixed
 * - Total de Custo VARIÁVEL = parcela com costClassification = variable
 * (Não classificado = Total Pago − Fixo − Variável.) Só o período filtra;
 * situação e fornecedor não entram. Pagamento parcial conta pelo que foi pago.
 */

import { endOfMonth, monthOf, startOfMonth, type ISODate } from "@/core/dates";
import type { Payable } from "@/core/entities";

export type DuePeriodOrigin = "de-ate" | "de" | "ate" | "mes" | "mes-corrente";

export interface DuePeriod {
  /** Inclusivo. */
  from: ISODate;
  /** Inclusivo. */
  to: ISODate;
  origin: DuePeriodOrigin;
}

export interface DuePeriodInput {
  de?: ISODate;
  ate?: ISODate;
  ano?: number;
  mes?: number;
}

export function resolveDuePeriod(input: DuePeriodInput, today: ISODate): DuePeriod {
  const { de, ate, ano, mes } = input;
  if (de && ate) return { from: de, to: ate, origin: "de-ate" };
  if (de) return { from: de, to: endOfMonth(monthOf(de)), origin: "de" };
  if (ate) return { from: startOfMonth(monthOf(ate)), to: ate, origin: "ate" };
  // Mês de referência: o selecionado (no ano selecionado ou no corrente);
  // sem Mês, o mês corrente — sempre do primeiro ao último dia.
  const anoRef = ano ?? Number(today.slice(0, 4));
  const mesRef = mes ?? Number(today.slice(5, 7));
  const key = `${anoRef}-${String(mesRef).padStart(2, "0")}`;
  return { from: startOfMonth(key), to: endOfMonth(key), origin: mes ? "mes" : "mes-corrente" };
}

export interface PeriodTotals {
  paidCents: number;
  fixedCents: number;
  variableCents: number;
  unclassifiedCents: number;
  /** Títulos (não cancelados) com vencimento no período — pagos ou não. */
  titulos: number;
}

export function sumPaidInDuePeriod(
  payables: readonly Payable[],
  period: DuePeriod
): PeriodTotals {
  let paidCents = 0;
  let fixedCents = 0;
  let variableCents = 0;
  let titulos = 0;
  for (const p of payables) {
    if (p.status === "canceled") continue;
    if (p.dueDate < period.from || p.dueDate > period.to) continue;
    titulos += 1;
    const pago = Math.max(0, p.paidCents);
    paidCents += pago;
    if (p.costClassification === "fixed") fixedCents += pago;
    else if (p.costClassification === "variable") variableCents += pago;
  }
  return {
    paidCents,
    fixedCents,
    variableCents,
    unclassifiedCents: paidCents - fixedCents - variableCents,
    titulos,
  };
}
