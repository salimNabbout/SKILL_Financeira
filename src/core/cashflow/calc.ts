/**
 * Regras de cálculo do Fluxo de Caixa — abas "Fluxo Mensal" e "Previsto x
 * Realizado" da planilha "Fluxo de Caixa CETEM". Domínio puro: recebe os
 * lançamentos já unificados (`unifyCashflow`) e devolve as grades tipadas.
 *
 * Fórmulas (todas em centavos inteiros; somas exatas):
 *  - valor(categoria, mês)   = Σ valor dos lançamentos da categoria no mês do
 *                              ano base (previsto e realizado somam juntos);
 *  - Total de Entradas (mês) = Σ das 4 categorias de entrada;
 *  - Total de Saídas (mês)   = Σ dos 6 subtotais de grupo de saída;
 *  - Resultado do Mês        = Entradas − Saídas;
 *  - Saldo Inicial (jan)     = saldo inicial do parâmetro; (demais meses) =
 *                              Saldo Final do mês anterior — encadeamento;
 *  - Saldo Final             = Saldo Inicial + Resultado do Mês;
 *  - Situação                = CAIXA NEGATIVO se Saldo Final < 0; Abaixo da
 *                              reserva se < reserva mínima; senão OK;
 *  - Total do Ano            = Σ dos 12 meses, por linha.
 *
 * Previsto x Realizado: para Total de Entradas, Total de Saídas e cada grupo
 * de saída, por mês: Previsto = Σ status previsto; Realizado = Σ status
 * realizado; Variação = Realizado − Previsto (em saídas, variação positiva é
 * gasto acima do planejado).
 */

import type { CashflowCategory, CashflowEntry, CashflowGroup } from "@/core/entities";
import { CASHFLOW_EXPENSE_GROUPS, CASHFLOW_GROUP_LABEL } from "./plan";

/** 12 posições, índice 0 = janeiro. */
export type MonthlySeries = number[];

export type CashSituation = "ok" | "abaixo_reserva" | "caixa_negativo";

export const CASH_SITUATION_LABEL: Record<CashSituation, string> = {
  ok: "OK",
  abaixo_reserva: "Abaixo da reserva",
  caixa_negativo: "CAIXA NEGATIVO",
};

export interface MonthlyRow {
  categoryId: string;
  name: string;
  kind: CashflowCategory["kind"];
  group: CashflowGroup;
  groupLabel: string;
  classification: CashflowCategory["classification"];
  months: MonthlySeries;
  totalCents: number;
}

export interface MonthlyGroupSubtotal {
  group: CashflowGroup;
  label: string;
  months: MonthlySeries;
  totalCents: number;
}

export interface MonthlyStatement {
  year: number;
  openingBalanceCents: number;
  minimumReserveCents: number;
  /** Uma linha por categoria do plano (exceto a neutra), na ordem da planilha. */
  rows: MonthlyRow[];
  entradasTotal: MonthlySeries;
  entradasAnoCents: number;
  /** Os 6 subtotais de grupo de saída, na ordem da planilha. */
  saidasGrupos: MonthlyGroupSubtotal[];
  saidasTotal: MonthlySeries;
  saidasAnoCents: number;
  resultado: MonthlySeries;
  resultadoAnoCents: number;
  saldoInicial: MonthlySeries;
  saldoFinal: MonthlySeries;
  situacao: CashSituation[];
  /** Lançamentos do ano que caíram em `a_classificar` (fila de revisão). */
  naoClassificadosCents: number;
  naoClassificadosCount: number;
}

export interface MonthlyInput {
  year: number;
  entries: CashflowEntry[];
  categories: CashflowCategory[];
  openingBalanceCents: number;
  minimumReserveCents: number;
}

const zeros = (): MonthlySeries => Array.from({ length: 12 }, () => 0);
const sum = (s: MonthlySeries): number => s.reduce((a, b) => a + b, 0);
const addSeries = (a: MonthlySeries, b: MonthlySeries): MonthlySeries => a.map((v, i) => v + b[i]);

export function computeMonthly(input: MonthlyInput): MonthlyStatement {
  const categories = [...input.categories]
    .filter((c) => c.kind !== "neutro")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const byCategory = new Map<string, MonthlySeries>(categories.map((c) => [c.id, zeros()]));
  let naoClassificadosCents = 0;
  let naoClassificadosCount = 0;

  for (const e of input.entries) {
    if (e.year !== input.year) continue;
    const series = byCategory.get(e.categoryId);
    if (!series) continue; // categoria desconhecida/neutra: fora da grade
    series[e.month - 1] += e.amountCents;
    if (e.categoryId === "a_classificar") {
      naoClassificadosCents += e.amountCents;
      naoClassificadosCount += 1;
    }
  }

  const rows: MonthlyRow[] = categories.map((c) => {
    const months = byCategory.get(c.id) ?? zeros();
    return {
      categoryId: c.id,
      name: c.name,
      kind: c.kind,
      group: c.group,
      groupLabel: CASHFLOW_GROUP_LABEL[c.group],
      classification: c.classification,
      months,
      totalCents: sum(months),
    };
  });

  const entradasTotal = rows.filter((r) => r.kind === "entrada").reduce((acc, r) => addSeries(acc, r.months), zeros());
  const saidasGrupos: MonthlyGroupSubtotal[] = CASHFLOW_EXPENSE_GROUPS.map((group) => {
    const months = rows
      .filter((r) => r.kind === "saida" && r.group === group)
      .reduce((acc, r) => addSeries(acc, r.months), zeros());
    return { group, label: CASHFLOW_GROUP_LABEL[group], months, totalCents: sum(months) };
  });
  const saidasTotal = saidasGrupos.reduce((acc, g) => addSeries(acc, g.months), zeros());
  const resultado = entradasTotal.map((v, i) => v - saidasTotal[i]);

  const saldoInicial = zeros();
  const saldoFinal = zeros();
  for (let i = 0; i < 12; i++) {
    saldoInicial[i] = i === 0 ? input.openingBalanceCents : saldoFinal[i - 1];
    saldoFinal[i] = saldoInicial[i] + resultado[i];
  }
  const situacao = saldoFinal.map<CashSituation>((s) =>
    s < 0 ? "caixa_negativo" : s < input.minimumReserveCents ? "abaixo_reserva" : "ok"
  );

  return {
    year: input.year,
    openingBalanceCents: input.openingBalanceCents,
    minimumReserveCents: input.minimumReserveCents,
    rows,
    entradasTotal,
    entradasAnoCents: sum(entradasTotal),
    saidasGrupos,
    saidasTotal,
    saidasAnoCents: sum(saidasTotal),
    resultado,
    resultadoAnoCents: sum(resultado),
    saldoInicial,
    saldoFinal,
    situacao,
    naoClassificadosCents,
    naoClassificadosCount,
  };
}

// ---------------------------------------------------------------------------
// Previsto x Realizado
// ---------------------------------------------------------------------------

export interface VarianceLine {
  key: "entradas" | "saidas" | CashflowGroup;
  label: string;
  /** "entrada" para o total de entradas; "saida" para o total e os grupos de saída. */
  kind: "entrada" | "saida";
  previsto: MonthlySeries;
  realizado: MonthlySeries;
  /** Realizado − Previsto. Em saídas, positivo = gasto acima do planejado. */
  variacao: MonthlySeries;
  previstoAnoCents: number;
  realizadoAnoCents: number;
  variacaoAnoCents: number;
}

export interface VarianceStatement {
  year: number;
  lines: VarianceLine[];
}

export interface VarianceInput {
  year: number;
  entries: CashflowEntry[];
  categories: CashflowCategory[];
}

export function computeVariance(input: VarianceInput): VarianceStatement {
  const kindOf = new Map(input.categories.map((c) => [c.id, c.kind]));
  const groupOf = new Map(input.categories.map((c) => [c.id, c.group]));

  const mk = (key: VarianceLine["key"], label: string, kind: VarianceLine["kind"]): VarianceLine => ({
    key,
    label,
    kind,
    previsto: zeros(),
    realizado: zeros(),
    variacao: zeros(),
    previstoAnoCents: 0,
    realizadoAnoCents: 0,
    variacaoAnoCents: 0,
  });
  const entradas = mk("entradas", "Total de Entradas", "entrada");
  const saidas = mk("saidas", "Total de Saídas", "saida");
  const grupos = new Map<CashflowGroup, VarianceLine>(
    CASHFLOW_EXPENSE_GROUPS.map((g) => [g, mk(g, CASHFLOW_GROUP_LABEL[g], "saida")])
  );

  for (const e of input.entries) {
    if (e.year !== input.year) continue;
    const kind = kindOf.get(e.categoryId);
    if (kind === "entrada") {
      (e.status === "realizado" ? entradas.realizado : entradas.previsto)[e.month - 1] += e.amountCents;
    } else if (kind === "saida") {
      (e.status === "realizado" ? saidas.realizado : saidas.previsto)[e.month - 1] += e.amountCents;
      const line = grupos.get(groupOf.get(e.categoryId) ?? "outras");
      if (line) (e.status === "realizado" ? line.realizado : line.previsto)[e.month - 1] += e.amountCents;
    }
  }

  const lines = [entradas, saidas, ...grupos.values()].map((l) => {
    l.variacao = l.realizado.map((v, i) => v - l.previsto[i]);
    l.previstoAnoCents = sum(l.previsto);
    l.realizadoAnoCents = sum(l.realizado);
    l.variacaoAnoCents = l.realizadoAnoCents - l.previstoAnoCents;
    return l;
  });
  return { year: input.year, lines };
}

// ---------------------------------------------------------------------------
// Utilitários de mês
// ---------------------------------------------------------------------------

const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "2026-09" → "set/2026". */
export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split("-");
  return `${MESES_ABREV[Number(m) - 1]}/${y}`;
}
