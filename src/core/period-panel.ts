/**
 * Painel por Período do Dashboard — cálculo puro sobre agregados que o banco
 * já devolveu (nada de somar títulos no frontend).
 *
 * Regime de CAIXA: vale a data do pagamento/recebimento efetivo, nunca o
 * vencimento. Período sempre inclusivo nas duas pontas, no fuso da empresa.
 *
 * Fórmulas (documentadas em PERIOD_PANEL_FORMULAS):
 * - Total Recebido      = Σ Receipt.amountCents ativos com receivedDate no período
 * - Total Pago          = Σ Payment.amountCents executados com data de execução no período
 *                         (título não cancelado)
 * - Custo Fixo pago     = parcela do Total Pago com Payable.costClassification = "fixed"
 * - Custo Variável pago = idem "variable"
 * - Não classificado    = Total Pago − Fixo − Variável (títulos sem classificação)
 * - Total do centro     = parcela do Total Pago com Payable.costCenterId = centro
 *                         (ou o Total Pago com "Todos"); "sem centro" é uma faixa própria
 * - Total por categoria = parcela do total do centro com Payable.supplierCategory = categoria
 * Identidades (testadas): Fixo + Variável + Não classificado = Total Pago;
 * Σ centros + sem centro = Total Pago; Σ categorias do centro = total do centro.
 */

import { endOfMonth, type ISODate } from "./dates";
import type { CostCenter, ID } from "./entities";
import { ValidationError } from "./errors";
import type { ExecutedPaymentsGroup } from "./repositories";

export const PERIOD_PANEL_FORMULAS = {
  received:
    "Total Recebido = Σ Receipt.amountCents com status ≠ canceled e receivedDate em [início, fim] (inclusivo) — regime de caixa, valor efetivamente recebido (inclui multa/juros)",
  paid:
    "Total Pago = Σ Payment.amountCents com status = executed e data de execução (executedAt no fuso da empresa) em [início, fim] (inclusivo), título com status ≠ canceled — pagamento parcial conta pelo que foi pago",
  fixed: "Custo Fixo pago = parcela do Total Pago cujo título tem costClassification = fixed",
  variable: "Custo Variável pago = parcela do Total Pago cujo título tem costClassification = variable",
  unclassified:
    "Não classificado = Total Pago − Custo Fixo − Custo Variável (títulos sem classificação); Fixo + Variável + Não classificado = Total Pago",
  costCenter:
    "Total Gasto no Centro de Custo = parcela do Total Pago cujo título tem costCenterId = centro selecionado; com 'Todos', o próprio Total Pago; títulos sem centro formam a faixa 'Sem centro' (Σ centros + Sem centro = Total Pago)",
  category:
    "Total Gasto por Categoria = parcela do total do centro cujo título tem supplierCategory = categoria selecionada (Categoria de Fornecedores do título); Σ categorias do centro = total do centro",
} as const;

// ---------------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------------

export interface PeriodInput {
  year: number;
  /** 1..12; ausente = ano inteiro (dias ignorados). */
  month?: number;
  dayFrom?: number;
  dayTo?: number;
}

export interface ResolvedPeriod {
  from: ISODate;
  to: ISODate;
  year: number;
  month?: number;
  /** Dias efetivos (já ajustados ao tamanho do mês); iguais a 1 e ao último dia quando o mês é "Todos". */
  dayFrom: number;
  dayTo: number;
  daysInMonth?: number;
  /** "01/09/2026 a 30/09/2026" */
  label: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const br = (iso: ISODate): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Padrão ao abrir: ano e mês correntes, dia 1 até o último dia do mês. */
export function defaultPeriodInput(today: ISODate): PeriodInput {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return { year, month, dayFrom: 1, dayTo: Number(endOfMonth(`${year}-${pad2(month)}`).slice(8, 10)) };
}

/**
 * Resolve o período inclusivo. Dias fora do mês são AJUSTADOS ao tamanho do
 * mês (trocar para mês mais curto não quebra); dia inicial > dia final depois
 * do ajuste é erro de validação.
 */
export function resolvePeriod(input: PeriodInput): ResolvedPeriod {
  const { year } = input;
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new ValidationError(`Ano inválido: ${year}.`);
  }
  if (input.month === undefined) {
    const from: ISODate = `${year}-01-01`;
    const to: ISODate = `${year}-12-31`;
    return { from, to, year, dayFrom: 1, dayTo: 31, label: `${br(from)} a ${br(to)}` };
  }
  const month = input.month;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError(`Mês inválido: ${month}.`);
  }
  const ym = `${year}-${pad2(month)}`;
  const daysInMonth = Number(endOfMonth(ym).slice(8, 10));
  const clamp = (d: number | undefined, fallback: number): number => {
    if (d === undefined) return fallback;
    if (!Number.isInteger(d) || d < 1) throw new ValidationError(`Dia inválido: ${d}.`);
    return Math.min(d, daysInMonth);
  };
  const dayFrom = clamp(input.dayFrom, 1);
  const dayTo = clamp(input.dayTo, daysInMonth);
  if (dayFrom > dayTo) {
    throw new ValidationError(`Dia inicial (${dayFrom}) maior que o dia final (${dayTo}).`);
  }
  const from: ISODate = `${ym}-${pad2(dayFrom)}`;
  const to: ISODate = `${ym}-${pad2(dayTo)}`;
  return { from, to, year, month, dayFrom, dayTo, daysInMonth, label: `${br(from)} a ${br(to)}` };
}

// ---------------------------------------------------------------------------
// Agregação dos pagamentos por dimensão
// ---------------------------------------------------------------------------

export interface PaidTotals {
  paidCents: number;
  paidCount: number;
  fixedCents: number;
  variableCents: number;
  unclassifiedCents: number;
}

export interface CostCenterTotal {
  /** null = títulos sem centro de custo. */
  costCenterId: ID | null;
  code: string;
  name: string;
  totalCents: number;
  count: number;
}

export interface CategoryTotal {
  /** Nome da categoria de fornecedor do título; "(sem categoria)" quando vazio. */
  category: string;
  totalCents: number;
  count: number;
  /** % do total do centro, 2 casas; 0 quando o centro é zero. */
  percentOfCenter: number;
}

export interface PaidSummary extends PaidTotals {
  /** Todos os centros com movimento no período (+ "Sem centro" quando houver), maior primeiro. */
  byCostCenter: CostCenterTotal[];
  /** Centro selecionado (null = Todos). */
  selectedCostCenterId: ID | null;
  costCenterTotalCents: number;
  /** Categorias com movimento no centro selecionado (ou em todos), maior primeiro. */
  categories: CategoryTotal[];
  /** Categoria selecionada (null = Todos). */
  selectedCategory: string | null;
  categoryTotalCents: number;
}

export const SEM_CENTRO = "Sem centro";
export const SEM_CATEGORIA = "(sem categoria)";

function categoryKey(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return v === "" ? SEM_CATEGORIA : v;
}

export interface PaidSelection {
  costCenterId?: ID | null;
  category?: string | null;
}

/**
 * Resume os agregados devolvidos pelo banco. `costCenters` serve para rotular
 * (código — nome); um centro que aparece nos agregados mas não no cadastro é
 * rotulado pelo id.
 */
export function summarizePaid(
  groups: readonly ExecutedPaymentsGroup[],
  costCenters: readonly Pick<CostCenter, "id" | "code" | "name">[],
  selection: PaidSelection = {}
): PaidSummary {
  let paidCents = 0;
  let paidCount = 0;
  let fixedCents = 0;
  let variableCents = 0;
  const byCenter = new Map<ID | null, { totalCents: number; count: number }>();

  for (const g of groups) {
    paidCents += g.totalCents;
    paidCount += g.count;
    if (g.costClassification === "fixed") fixedCents += g.totalCents;
    else if (g.costClassification === "variable") variableCents += g.totalCents;
    const key = g.costCenterId ?? null;
    const acc = byCenter.get(key) ?? { totalCents: 0, count: 0 };
    acc.totalCents += g.totalCents;
    acc.count += g.count;
    byCenter.set(key, acc);
  }
  const unclassifiedCents = paidCents - fixedCents - variableCents;

  const centerById = new Map(costCenters.map((c) => [c.id, c]));
  const byCostCenter: CostCenterTotal[] = [...byCenter.entries()]
    .map(([id, t]) => {
      const cc = id ? centerById.get(id) : undefined;
      return {
        costCenterId: id,
        code: id ? (cc?.code ?? id) : "",
        name: id ? (cc?.name ?? id) : SEM_CENTRO,
        totalCents: t.totalCents,
        count: t.count,
      };
    })
    .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));

  const selectedCostCenterId = selection.costCenterId ?? null;
  const inCenter = selectedCostCenterId
    ? groups.filter((g) => g.costCenterId === selectedCostCenterId)
    : groups;
  const costCenterTotalCents = inCenter.reduce((s, g) => s + g.totalCents, 0);

  const byCategory = new Map<string, { totalCents: number; count: number }>();
  for (const g of inCenter) {
    const key = categoryKey(g.supplierCategory);
    const acc = byCategory.get(key) ?? { totalCents: 0, count: 0 };
    acc.totalCents += g.totalCents;
    acc.count += g.count;
    byCategory.set(key, acc);
  }
  const categories: CategoryTotal[] = [...byCategory.entries()]
    .map(([category, t]) => ({
      category,
      totalCents: t.totalCents,
      count: t.count,
      percentOfCenter:
        costCenterTotalCents > 0
          ? Math.round((t.totalCents * 10000) / costCenterTotalCents) / 100
          : 0,
    }))
    .sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category));

  const selectedCategory = selection.category ? categoryKey(selection.category) : null;
  const categoryTotalCents = selectedCategory
    ? (byCategory.get(selectedCategory)?.totalCents ?? 0)
    : costCenterTotalCents;

  return {
    paidCents,
    paidCount,
    fixedCents,
    variableCents,
    unclassifiedCents,
    byCostCenter,
    selectedCostCenterId,
    costCenterTotalCents,
    categories,
    selectedCategory,
    categoryTotalCents,
  };
}
