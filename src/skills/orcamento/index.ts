/**
 * Skill ORÇAMENTO E PLANEJAMENTO — orçamento por centro de custo/categoria/
 * período, realizado vs. orçado com variações absolutas e percentuais,
 * verificação de impacto orçamentário de novos títulos, forecast por média
 * móvel e detecção de desvios relevantes.
 *
 * Definição de REALIZADO (limitação declarada em assumptions):
 * - despesas = Payments com status "executed" no período (mês extraído de
 *   executedAt, tratado em UTC; categoria/centro herdados do payable);
 * - receitas = Receipts com receivedDate no período (categoria/centro
 *   herdados do receivable).
 * Baixas de payable via conciliação sem Payment (paidCents) NÃO entram.
 *
 * Esta skill nunca movimenta dinheiro: apenas mede, projeta e alerta.
 */

import { z } from "zod";
import { addMonths, monthOf, startOfMonth, type ISOMonth } from "@/core/dates";
import type { Budget, BudgetLine, ID } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import { formatBRL } from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL = "orcamento_planejamento" as const;
const DATA_SOURCES = [
  "budgets",
  "budget_lines",
  "payables",
  "payments",
  "receivables",
  "receipts",
  "categories",
  "cost_centers",
];

/** Desvio só é relevante se, além do %, a variância absoluta passar de R$ 100,00. */
const MIN_DEVIATION_ABS_CENTS = 10_000;

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "período inválido (esperado YYYY-MM)" });

const budgetLineInputSchema = z.object({
  period: periodSchema,
  categoryId: z.string().min(1).optional(),
  costCenterId: z.string().min(1).optional(),
  amountCents: z.number().int().nonnegative(),
});

const upsertBudgetSchema = z.object({
  action: z.literal("upsert_budget"),
  name: z.string().min(1),
  year: z.number().int().min(2000).max(2100),
  lines: z.array(budgetLineInputSchema).min(1),
});

const varianceReportSchema = z.object({
  action: z.literal("variance_report"),
  period: periodSchema,
});

const checkImpactSchema = z.object({
  action: z.literal("check_impact"),
  payableIds: z.array(z.string().min(1)),
});

const forecastSchema = z.object({
  action: z.literal("forecast"),
  months: z.number().int().min(1).max(24).optional(),
});

export const orcamentoInputSchema = z.discriminatedUnion("action", [
  upsertBudgetSchema,
  varianceReportSchema,
  checkImpactSchema,
  forecastSchema,
]);

export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;
export type VarianceReportInput = z.infer<typeof varianceReportSchema>;
export type CheckImpactInput = z.infer<typeof checkImpactSchema>;
export type ForecastInput = z.infer<typeof forecastSchema>;
export type OrcamentoInput = z.infer<typeof orcamentoInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface UpsertBudgetData {
  budget: Budget;
  lines: BudgetLine[];
}

export interface VarianceLine {
  budgetLineId: ID;
  categoryId?: ID;
  categoryName?: string;
  costCenterId?: ID;
  budgetedCents: number;
  actualCents: number;
  varianceCents: number;
  /** variância/orçado×100 (2 casas); null quando orçado = 0. */
  variancePercent: number | null;
}

export interface VarianceReportData {
  period: ISOMonth;
  lines: VarianceLine[];
  totals: { budgetedCents: number; actualCents: number; varianceCents: number };
  formula: string;
}

export interface ImpactEntry {
  payableId: ID;
  period: ISOMonth;
  categoryId?: ID;
  budgetedCents: number;
  committedCents: number;
  remainingCents: number;
  exceeded: boolean;
}

export interface CheckImpactData {
  impacts: ImpactEntry[];
  formula: string;
}

export interface ForecastCategory {
  categoryId: ID;
  categoryName: string;
  monthlyAvgCents: number;
  projected: { period: ISOMonth; amountCents: number }[];
}

export interface ForecastData {
  months: number;
  historyMonths: ISOMonth[];
  byCategory: ForecastCategory[];
  formula: string;
}

export type OrcamentoData = UpsertBudgetData | VarianceReportData | CheckImpactData | ForecastData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REALIZED_FORMULA =
  "realizado(despesa) = Σ payments executados no mês (mês de executedAt em UTC, categoria/centro do payable); " +
  "realizado(receita) = Σ receipts com receivedDate no mês (categoria/centro do receivable)";

const REALIZED_LIMITATION =
  "Realizado considera apenas Payments executados e Receipts como fontes primárias; " +
  "baixas de títulos via conciliação sem Payment (paidCents) não são capturadas.";

/** Movimento realizado normalizado (despesa via Payment, receita via Receipt). */
interface RealizedItem {
  period: ISOMonth;
  categoryId?: ID;
  costCenterId?: ID;
  amountCents: number;
  kind: "expense" | "income";
}

async function loadRealizedItems(ctx: SkillContext): Promise<RealizedItem[]> {
  const [payments, payables, receipts, receivables] = await Promise.all([
    ctx.repos.payments.listAll(ctx.companyId),
    ctx.repos.payables.listAll(ctx.companyId),
    ctx.repos.receipts.listAll(ctx.companyId),
    ctx.repos.receivables.listAll(ctx.companyId),
  ]);
  const payableById = new Map(payables.map((p) => [p.id, p]));
  const receivableById = new Map(receivables.map((r) => [r.id, r]));

  const items: RealizedItem[] = [];
  for (const payment of payments) {
    if (payment.status !== "executed" || !payment.executedAt) continue;
    const payable = payableById.get(payment.payableId);
    items.push({
      period: payment.executedAt.slice(0, 7),
      categoryId: payable?.categoryId,
      costCenterId: payable?.costCenterId,
      amountCents: payment.amountCents,
      kind: "expense",
    });
  }
  for (const receipt of receipts) {
    const receivable = receivableById.get(receipt.receivableId);
    items.push({
      period: monthOf(receipt.receivedDate),
      categoryId: receivable?.categoryId,
      costCenterId: receivable?.costCenterId,
      amountCents: receipt.amountCents,
      kind: "income",
    });
  }
  return items;
}

/** Orçamento ativo do ano; se houver mais de um, usa o mais recente (createdAt). */
async function findActiveBudget(ctx: SkillContext, year: number): Promise<Budget | null> {
  const budgets = (await ctx.repos.budgets.listAll(ctx.companyId)).filter(
    (b) => b.year === year && b.status === "active"
  );
  if (budgets.length === 0) return null;
  budgets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return budgets[0];
}

function lineKey(period: string, categoryId?: ID, costCenterId?: ID): string {
  return `${period}|${categoryId ?? ""}|${costCenterId ?? ""}`;
}

/** Dedupe exigido: não persiste alerta se já houver um ABERTO com mesmo code+entityId. */
async function persistAlertDeduped(ctx: SkillContext, alert: SkillAlert): Promise<void> {
  const open = await ctx.repos.alerts.listOpen(ctx.companyId);
  if (open.some((a) => a.code === alert.code && a.entityId === alert.entityId)) return;
  await ctx.repos.alerts.create({
    id: ctx.ids.next("alr"),
    companyId: ctx.companyId,
    severity: alert.severity,
    code: alert.code,
    message: alert.message,
    entityType: alert.entityType,
    entityId: alert.entityId,
    source: SKILL,
    status: "open",
    createdAt: ctx.clock.now().toISOString(),
  });
}

function sortLines(lines: BudgetLine[]): BudgetLine[] {
  return [...lines].sort((a, b) =>
    lineKey(a.period, a.categoryId, a.costCenterId) <
    lineKey(b.period, b.categoryId, b.costCenterId)
      ? -1
      : 1
  );
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Ação 1: upsert_budget — idempotente por (name, year)
// ---------------------------------------------------------------------------

async function upsertBudget(
  ctx: SkillContext,
  input: UpsertBudgetInput
): Promise<SkillResult<UpsertBudgetData>> {
  const assumptions: string[] = [];

  // Chaves duplicadas na entrada quebrariam o casamento por (period, categoria, centro).
  const seenKeys = new Set<string>();
  for (const line of input.lines) {
    if (!line.period.startsWith(`${input.year}-`)) {
      throw new ValidationError(
        `Linha com período ${line.period} fora do ano do orçamento (${input.year}).`
      );
    }
    const key = lineKey(line.period, line.categoryId, line.costCenterId);
    if (seenKeys.has(key)) {
      throw new ValidationError(
        `Linha duplicada na entrada para (período ${line.period}, categoria ${line.categoryId ?? "—"}, centro ${line.costCenterId ?? "—"}).`
      );
    }
    seenKeys.add(key);
    if (line.categoryId) {
      const category = await ctx.repos.categories.getById(ctx.companyId, line.categoryId);
      if (!category) throw new NotFoundError("Categoria", line.categoryId);
    }
    if (line.costCenterId) {
      const costCenter = await ctx.repos.costCenters.getById(ctx.companyId, line.costCenterId);
      if (!costCenter) throw new NotFoundError("Centro de custo", line.costCenterId);
    }
  }

  const nowIso = ctx.clock.now().toISOString();
  const existing = (await ctx.repos.budgets.listAll(ctx.companyId)).find(
    (b) => b.name === input.name && b.year === input.year
  );

  let budget: Budget;
  let currentLines: BudgetLine[] = [];
  if (existing) {
    budget = existing;
    currentLines = await ctx.repos.budgetLines.listByBudget(budget.id);
    assumptions.push(
      `Orçamento "${input.name}"/${input.year} já existia (${budget.id}); linhas foram atualizadas por (período, categoria, centro) sem criar orçamento duplicado.`
    );
  } else {
    budget = await ctx.repos.budgets.create({
      id: ctx.ids.next("bud"),
      companyId: ctx.companyId,
      name: input.name,
      year: input.year,
      status: "active",
      createdAt: nowIso,
    });
  }

  const currentByKey = new Map(
    currentLines.map((l) => [lineKey(l.period, l.categoryId, l.costCenterId), l])
  );
  const touched = new Set<string>();
  const resultLines: BudgetLine[] = [];

  for (const line of input.lines) {
    const key = lineKey(line.period, line.categoryId, line.costCenterId);
    touched.add(key);
    const match = currentByKey.get(key);
    if (match) {
      if (match.amountCents === line.amountCents) {
        resultLines.push(match);
        continue;
      }
      const updated = await ctx.repos.budgetLines.update({
        ...match,
        amountCents: line.amountCents,
      });
      resultLines.push(updated);
      continue;
    }
    const created = await ctx.repos.budgetLines.create({
      id: ctx.ids.next("bl"),
      budgetId: budget.id,
      period: line.period,
      categoryId: line.categoryId,
      costCenterId: line.costCenterId,
      amountCents: line.amountCents,
    });
    resultLines.push(created);
  }

  // Linhas órfãs (não presentes na nova versão): BudgetLineRepo não tem delete,
  // então o "delete lógico" é zerar o valor.
  for (const line of currentLines) {
    const key = lineKey(line.period, line.categoryId, line.costCenterId);
    if (touched.has(key)) continue;
    if (line.amountCents !== 0) {
      const zeroed = await ctx.repos.budgetLines.update({ ...line, amountCents: 0 });
      resultLines.push(zeroed);
      assumptions.push(
        `Linha órfã (período ${line.period}, categoria ${line.categoryId ?? "—"}, centro ${line.costCenterId ?? "—"}) não veio na nova versão e teve o valor zerado (repositório não permite exclusão).`
      );
    } else {
      resultLines.push(line);
    }
  }

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: existing ? "budget.updated" : "budget.created",
    entityType: "budget",
    entityId: budget.id,
    before: existing ? { budget: existing, lines: currentLines } : undefined,
    after: { budget, lines: sortLines(resultLines) },
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    { budget, lines: sortLines(resultLines) },
    { assumptions, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Ação 2: variance_report — realizado vs. orçado do período
// ---------------------------------------------------------------------------

/** Realizado que "cai" numa linha orçada: dimensões da linha agem como filtro. */
function actualForLine(
  items: RealizedItem[],
  line: BudgetLine,
  kind: "expense" | "income"
): number {
  return items
    .filter(
      (i) =>
        i.period === line.period &&
        i.kind === kind &&
        (line.categoryId === undefined || i.categoryId === line.categoryId) &&
        (line.costCenterId === undefined || i.costCenterId === line.costCenterId)
    )
    .reduce((acc, i) => acc + i.amountCents, 0);
}

async function varianceReport(
  ctx: SkillContext,
  input: VarianceReportInput
): Promise<SkillResult<VarianceReportData>> {
  const assumptions: string[] = [REALIZED_LIMITATION];
  const alerts: SkillAlert[] = [];
  const pendingItems: PendingItem[] = [];
  const formula =
    `variância = realizado - orçado; variância% = variância/orçado×100 (orçado 0 → null); ${REALIZED_FORMULA}; ` +
    `desvio relevante: |variância%| > ${ctx.config.budgetDeviationAlertPercent}% e |variância| >= ${formatBRL(MIN_DEVIATION_ABS_CENTS)}`;

  const year = Number(input.period.slice(0, 4));
  const budget = await findActiveBudget(ctx, year);
  if (!budget) {
    pendingItems.push({
      code: "sem_orcamento",
      description: `Não há orçamento ativo para o ano ${year}; orçado vs. realizado não pôde ser apurado para ${input.period}.`,
      suggestedAction: "Cadastrar o orçamento anual via ação upsert_budget.",
    });
    return makeResult(
      SKILL,
      ctx,
      {
        period: input.period,
        lines: [],
        totals: { budgetedCents: 0, actualCents: 0, varianceCents: 0 },
        formula,
      },
      { status: "warning", pendingItems, assumptions, dataSources: DATA_SOURCES }
    );
  }

  const allLines = await ctx.repos.budgetLines.listByBudget(budget.id);
  const periodLines = sortLines(allLines.filter((l) => l.period === input.period));
  const items = await loadRealizedItems(ctx);
  const periodItems = items.filter((i) => i.period === input.period);
  const categories = await ctx.repos.categories.listAll(ctx.companyId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const lines: VarianceLine[] = [];
  for (const line of periodLines) {
    const category = line.categoryId ? categoryById.get(line.categoryId) : undefined;
    // Sem categoria na linha (ex.: linha só de centro de custo), medimos despesas.
    let kind: "expense" | "income" = "expense";
    if (category) {
      kind = category.kind;
    } else if (line.categoryId === undefined) {
      assumptions.push(
        `Linha ${line.id} sem categoria: realizado apurado apenas sobre despesas (payments executados).`
      );
    }
    const actualCents = actualForLine(periodItems, line, kind);
    const varianceCents = actualCents - line.amountCents;
    let variancePercent: number | null = null;
    if (line.amountCents === 0) {
      assumptions.push(
        `Linha ${line.id} com orçado zero: variância percentual indefinida (retornada como null).`
      );
    } else {
      variancePercent = roundPercent((varianceCents / line.amountCents) * 100);
    }

    lines.push({
      budgetLineId: line.id,
      categoryId: line.categoryId,
      categoryName: category?.name,
      costCenterId: line.costCenterId,
      budgetedCents: line.amountCents,
      actualCents,
      varianceCents,
      variancePercent,
    });

    const relevant =
      variancePercent !== null &&
      Math.abs(variancePercent) > ctx.config.budgetDeviationAlertPercent &&
      Math.abs(varianceCents) >= MIN_DEVIATION_ABS_CENTS;
    if (relevant) {
      const label = category?.name ?? line.categoryId ?? line.costCenterId ?? "geral";
      const alert: SkillAlert = {
        severity: "warning",
        code: "budget_deviation",
        message: `Desvio orçamentário relevante em ${input.period} (${label}): orçado ${formatBRL(line.amountCents)}, realizado ${formatBRL(actualCents)}, variação ${formatBRL(varianceCents)} (${variancePercent}%).`,
        entityType: "budget_line",
        entityId: line.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
      await ctx.events.publish({
        companyId: ctx.companyId,
        type: "budget.deviation_detected",
        payload: {
          period: input.period,
          budgetLineId: line.id,
          categoryId: line.categoryId,
          costCenterId: line.costCenterId,
          budgetedCents: line.amountCents,
          actualCents,
          varianceCents,
          variancePercent,
        },
        source: SKILL,
        correlationId: ctx.correlationId,
      });
    }
  }

  // Categorias com realizado no período sem linha orçada correspondente.
  const budgetedCategoryIds = new Set(
    periodLines.filter((l) => l.categoryId !== undefined).map((l) => l.categoryId as ID)
  );
  const hasWildcardLine = periodLines.some((l) => l.categoryId === undefined);
  const unbudgeted = new Map<string, number>();
  for (const item of periodItems) {
    if (item.categoryId === undefined) {
      if (!hasWildcardLine) {
        unbudgeted.set("", (unbudgeted.get("") ?? 0) + item.amountCents);
      }
      continue;
    }
    if (!budgetedCategoryIds.has(item.categoryId)) {
      unbudgeted.set(item.categoryId, (unbudgeted.get(item.categoryId) ?? 0) + item.amountCents);
    }
  }
  for (const [categoryId, amountCents] of unbudgeted) {
    const name = categoryId === "" ? "movimentos sem categoria" : (categoryById.get(categoryId)?.name ?? categoryId);
    pendingItems.push({
      code: "nao_orcado",
      description: `Realizado de ${formatBRL(amountCents)} em ${input.period} para "${name}" sem linha orçada correspondente.`,
      entityType: categoryId === "" ? undefined : "category",
      entityId: categoryId === "" ? undefined : categoryId,
      suggestedAction: "Incluir a categoria no orçamento (upsert_budget) ou revisar a classificação.",
    });
  }

  const totals = lines.reduce(
    (acc, l) => ({
      budgetedCents: acc.budgetedCents + l.budgetedCents,
      actualCents: acc.actualCents + l.actualCents,
      varianceCents: acc.varianceCents + l.varianceCents,
    }),
    { budgetedCents: 0, actualCents: 0, varianceCents: 0 }
  );

  return makeResult(
    SKILL,
    ctx,
    { period: input.period, lines, totals, formula },
    { alerts, pendingItems, assumptions, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Ação 3: check_impact — impacto orçamentário de títulos a pagar
// ---------------------------------------------------------------------------

const COMMITTED_STATUSES = ["open", "scheduled", "partially_paid"] as const;

/** Melhor linha orçada para (período, categoria, centro): match exato > só categoria > só centro. */
function findBudgetLineFor(
  lines: BudgetLine[],
  period: ISOMonth,
  categoryId?: ID,
  costCenterId?: ID
): BudgetLine | undefined {
  const inPeriod = lines.filter((l) => l.period === period);
  return (
    inPeriod.find((l) => l.categoryId === categoryId && l.costCenterId === costCenterId) ??
    inPeriod.find((l) => l.categoryId === categoryId && l.categoryId !== undefined && l.costCenterId === undefined) ??
    inPeriod.find((l) => l.categoryId === undefined && l.costCenterId !== undefined && l.costCenterId === costCenterId)
  );
}

async function checkImpact(
  ctx: SkillContext,
  input: CheckImpactInput
): Promise<SkillResult<CheckImpactData>> {
  const assumptions: string[] = [REALIZED_LIMITATION];
  const alerts: SkillAlert[] = [];
  const formula =
    "comprometido = Σ saldo restante (amountCents - paidCents) de payables abertos/agendados/parciais da mesma categoria com vencimento no mês (inclui o próprio título) " +
    "+ Σ payments executados da categoria no mês; restante = orçado - comprometido; estouro quando restante < 0";

  if (input.payableIds.length === 0) {
    assumptions.push("Nenhum título informado; nada a verificar.");
    return makeResult(
      SKILL,
      ctx,
      { impacts: [], formula },
      { assumptions, dataSources: DATA_SOURCES }
    );
  }

  const allPayables = await ctx.repos.payables.listAll(ctx.companyId);
  const payableById = new Map(allPayables.map((p) => [p.id, p]));
  const items = await loadRealizedItems(ctx);
  const budgetLinesByYear = new Map<number, BudgetLine[]>();

  const impacts: ImpactEntry[] = [];
  for (const payableId of input.payableIds) {
    const payable = payableById.get(payableId);
    if (!payable) throw new NotFoundError("Título a pagar", payableId);

    const period = monthOf(payable.dueDate);
    const year = Number(period.slice(0, 4));
    if (!budgetLinesByYear.has(year)) {
      const budget = await findActiveBudget(ctx, year);
      budgetLinesByYear.set(
        year,
        budget ? await ctx.repos.budgetLines.listByBudget(budget.id) : []
      );
    }
    const line = findBudgetLineFor(
      budgetLinesByYear.get(year) ?? [],
      period,
      payable.categoryId,
      payable.costCenterId
    );

    const committedOpen = allPayables
      .filter(
        (p) =>
          (COMMITTED_STATUSES as readonly string[]).includes(p.status) &&
          monthOf(p.dueDate) === period &&
          p.categoryId === payable.categoryId
      )
      .reduce((acc, p) => acc + (p.amountCents - p.paidCents), 0);
    const executed = items
      .filter(
        (i) => i.kind === "expense" && i.period === period && i.categoryId === payable.categoryId
      )
      .reduce((acc, i) => acc + i.amountCents, 0);
    const committedCents = committedOpen + executed;

    if (!line) {
      assumptions.push(
        `Título ${payable.id}: categoria ${payable.categoryId ?? "—"} sem orçamento no período ${period}; impacto não avaliado contra limite.`
      );
      impacts.push({
        payableId: payable.id,
        period,
        categoryId: payable.categoryId,
        budgetedCents: 0,
        committedCents,
        remainingCents: 0,
        exceeded: false,
      });
      continue;
    }

    const remainingCents = line.amountCents - committedCents;
    const exceeded = remainingCents < 0;
    impacts.push({
      payableId: payable.id,
      period,
      categoryId: payable.categoryId,
      budgetedCents: line.amountCents,
      committedCents,
      remainingCents,
      exceeded,
    });

    if (exceeded) {
      const alert: SkillAlert = {
        severity: "warning",
        code: "budget_impact_exceeded",
        message: `Título ${payable.id} (${payable.description}) estoura o orçamento de ${period}: orçado ${formatBRL(line.amountCents)}, comprometido ${formatBRL(committedCents)}, saldo ${formatBRL(remainingCents)}.`,
        entityType: "payable",
        entityId: payable.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
    }
  }

  return makeResult(
    SKILL,
    ctx,
    { impacts, formula },
    { alerts, assumptions, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Ação 4: forecast — média móvel de 3 meses por categoria
// ---------------------------------------------------------------------------

const FORECAST_WINDOW_MONTHS = 3;

async function forecast(
  ctx: SkillContext,
  input: ForecastInput
): Promise<SkillResult<ForecastData>> {
  const months = input.months ?? 3;
  const assumptions: string[] = [
    REALIZED_LIMITATION,
    "Sazonalidade ignorada: projeção por média móvel simples, repetindo a média mensal dos últimos 3 meses fechados.",
  ];

  const currentMonthStart = startOfMonth(monthOf(ctx.today()));
  const historyMonths: ISOMonth[] = [];
  for (let i = FORECAST_WINDOW_MONTHS; i >= 1; i--) {
    historyMonths.push(monthOf(addMonths(currentMonthStart, -i)));
  }
  const projectedPeriods: ISOMonth[] = [];
  for (let k = 1; k <= months; k++) {
    projectedPeriods.push(monthOf(addMonths(currentMonthStart, k)));
  }
  const formula =
    `média mensal = Σ realizado da categoria em [${historyMonths[0]}..${historyMonths[historyMonths.length - 1]}] / ${FORECAST_WINDOW_MONTHS} (arredondamento half-up em centavos); ` +
    `projeção(período) = média mensal para cada um dos ${months} meses a partir do mês seguinte ao corrente; ${REALIZED_FORMULA}`;

  const items = (await loadRealizedItems(ctx)).filter((i) =>
    historyMonths.includes(i.period)
  );
  const totalsByCategory = new Map<ID, number>();
  let uncategorizedCents = 0;
  for (const item of items) {
    if (item.categoryId === undefined) {
      uncategorizedCents += item.amountCents;
      continue;
    }
    totalsByCategory.set(
      item.categoryId,
      (totalsByCategory.get(item.categoryId) ?? 0) + item.amountCents
    );
  }
  if (uncategorizedCents > 0) {
    assumptions.push(
      `Movimentos sem categoria (${formatBRL(uncategorizedCents)} no período histórico) foram ignorados na projeção por categoria.`
    );
  }
  if (totalsByCategory.size === 0) {
    assumptions.push("Sem realizado nos últimos 3 meses fechados; projeção vazia.");
  }

  const categories = await ctx.repos.categories.listAll(ctx.companyId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const byCategory: ForecastCategory[] = [...totalsByCategory.entries()]
    .map(([categoryId, totalCents]) => {
      const monthlyAvgCents = Math.round(totalCents / FORECAST_WINDOW_MONTHS);
      return {
        categoryId,
        categoryName: categoryById.get(categoryId)?.name ?? categoryId,
        monthlyAvgCents,
        projected: projectedPeriods.map((period) => ({ period, amountCents: monthlyAvgCents })),
      };
    })
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName, "pt-BR"));

  return makeResult(
    SKILL,
    ctx,
    { months, historyMonths, byCategory, formula },
    // Média móvel é estimativa: confiança rebaixada por definição.
    { confidence: 0.5, assumptions, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const orcamentoSkill: SkillDefinition<OrcamentoInput, OrcamentoData> = {
  name: SKILL,
  responsibility:
    "Orçamento por centro de custo/categoria/período; realizado vs. orçado com variações; verificação de impacto orçamentário; forecast e detecção de desvios relevantes.",
  objective:
    "Dar visibilidade de aderência ao orçamento e antecipar estouros, sem nunca movimentar dinheiro — a skill mede, projeta e alerta.",
  inputSchema: orcamentoInputSchema,
  consumes: [],
  publishes: ["budget.deviation_detected"],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "upsert_budget":
        return upsertBudget(ctx, input);
      case "variance_report":
        return varianceReport(ctx, input);
      case "check_impact":
        return checkImpact(ctx, input);
      case "forecast":
        return forecast(ctx, input);
    }
  },
};
