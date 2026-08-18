/**
 * Skill: Tesouraria e Fluxo de Caixa (tesouraria_fluxo_caixa).
 *
 * Responsabilidade: consolidar entradas/saídas, calcular saldo disponível,
 * comprometido e projetado, gerar fluxo de caixa diário/semanal/mensal,
 * cenários otimista/base/pessimista e alertas de insuficiência.
 * A skill RECOMENDA ações — nunca movimenta dinheiro por conta própria.
 *
 * Definições determinísticas (documentadas também nos campos "formula"):
 * - Disponível por conta = openingBalanceCents + Σ bankTransactions.amountCents
 *   da conta (fonte: extrato importado).
 * - Comprometido = payments pending_approval|approved (ainda não executados)
 *   + payables "scheduled" sem payment pendente (saldo restante) — nunca conta
 *   duas vezes: se o payable tem payment pendente, conta só o payment.
 * - Projetado (horizonte) = disponível + entradas previstas (recebíveis
 *   abertos, saldo restante, por dueDate) − saídas previstas (títulos
 *   abertos/agendados, saldo restante, por dueDate; com payment pendente usa
 *   scheduledDate do payment). Vencidos não liquidados entram "hoje".
 */

import { z } from "zod";
import type {
  Alert,
  BankAccount,
  BankTransaction,
  ID,
  Payable,
  Payment,
  Receivable,
} from "@/core/entities";
import {
  addDays,
  addMonths,
  endOfMonth,
  formatBR,
  monthOf,
  startOfMonth,
  toUtcNoon,
  type ISODate,
} from "@/core/dates";
import { formatBRL, percentOf } from "@/core/money";
import type { SkillAlert } from "@/core/types";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";

const SKILL_NAME = "tesouraria_fluxo_caixa" as const;

const DATA_SOURCES = [
  "bank_accounts",
  "bank_transactions",
  "payments",
  "payables",
  "receivables",
] as const;

// ---------------------------------------------------------------------------
// Entrada (uma variante por ação)
// ---------------------------------------------------------------------------

const cashPositionSchema = z.object({
  action: z.literal("cash_position"),
});

const refreshProjectionSchema = z.object({
  action: z.literal("refresh_projection"),
  horizonDays: z.number().int().min(1).max(730).optional(),
});

const cashflowStatementSchema = z.object({
  action: z.literal("cashflow_statement"),
  granularity: z.enum(["daily", "weekly", "monthly"]),
  periods: z.number().int().min(2).max(120).optional(),
});

const scenariosSchema = z.object({
  action: z.literal("scenarios"),
  horizonDays: z.number().int().min(1).max(730).optional(),
});

export const tesourariaInputSchema = z.discriminatedUnion("action", [
  cashPositionSchema,
  refreshProjectionSchema,
  cashflowStatementSchema,
  scenariosSchema,
]);

export type CashPositionInput = z.infer<typeof cashPositionSchema>;
export type RefreshProjectionInput = z.infer<typeof refreshProjectionSchema>;
export type CashflowStatementInput = z.infer<typeof cashflowStatementSchema>;
export type ScenariosInput = z.infer<typeof scenariosSchema>;
export type TesourariaInput = z.infer<typeof tesourariaInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface AccountPosition {
  id: ID;
  name: string;
  availableCents: number;
}

export interface CashPositionData {
  accounts: AccountPosition[];
  totals: {
    availableCents: number;
    committedCents: number;
    projected30Cents: number;
  };
  period: { asOf: ISODate; projectionEnd: ISODate };
  formulas: { available: string; committed: string; projected30: string };
}

export interface DailyFlowPoint {
  date: ISODate;
  inCents: number;
  outCents: number;
  /** Saldo acumulado ao fim do dia (disponível + movimentos até a data). */
  balanceCents: number;
}

export interface ProjectionSummary {
  horizonStart: ISODate;
  horizonEnd: ISODate;
  openingBalanceCents: number;
  totalInCents: number;
  totalOutCents: number;
  endingBalanceCents: number;
  minBalanceCents: number;
  minBalanceDate: ISODate;
}

export interface RefreshProjectionData {
  summary: ProjectionSummary;
  daily: DailyFlowPoint[];
  recommendations: string[];
  formulas: { available: string; projection: string };
}

export type CashflowGranularity = "daily" | "weekly" | "monthly";

export interface CashflowBucket {
  label: string;
  start: ISODate;
  end: ISODate;
  realizedInCents: number;
  realizedOutCents: number;
  projectedInCents: number;
  projectedOutCents: number;
  netCents: number;
  cumulativeBalanceCents: number;
}

export interface CashflowStatementData {
  granularity: CashflowGranularity;
  buckets: CashflowBucket[];
  period: { start: ISODate; end: ISODate };
  formula: string;
}

export type ScenarioName = "otimista" | "base" | "pessimista";

export interface ScenarioParams {
  /** Percentual de realização das entradas previstas (0-100). */
  realizationPercent: number;
  /** Atraso médio (dias) aplicado às entradas ainda não vencidas. */
  delayDays: number;
  /** Dias, a partir de hoje, para receber os títulos já vencidos. */
  overdueDelayDays: number;
}

export interface ScenarioResult {
  name: ScenarioName;
  endingBalanceCents: number;
  minBalanceCents: number;
  minBalanceDate: ISODate;
  params: ScenarioParams;
}

export interface ScenariosData {
  scenarios: ScenarioResult[];
  horizonDays: number;
  period: { start: ISODate; end: ISODate };
  formula: string;
}

export type TesourariaData =
  | CashPositionData
  | RefreshProjectionData
  | CashflowStatementData
  | ScenariosData;

// ---------------------------------------------------------------------------
// Constantes de cálculo
// ---------------------------------------------------------------------------

const PENDING_PAYMENT_STATUSES = ["pending_approval", "approved"] as const;
const OPEN_PAYABLE_STATUSES = ["open", "scheduled", "partially_paid"] as const;
const OPEN_RECEIVABLE_STATUSES = ["open", "partially_received"] as const;

const SCENARIO_PARAMS: Record<ScenarioName, ScenarioParams> = {
  otimista: { realizationPercent: 100, delayDays: 0, overdueDelayDays: 7 },
  base: { realizationPercent: 95, delayDays: 7, overdueDelayDays: 21 },
  pessimista: { realizationPercent: 80, delayDays: 21, overdueDelayDays: 45 },
};

const FORMULA_AVAILABLE =
  "disponível(conta) = openingBalanceCents + Σ bankTransactions.amountCents da conta (fonte: extrato importado); disponível total = Σ contas ativas";
const FORMULA_COMMITTED =
  "comprometido = Σ payments em pending_approval|approved (não executados) + Σ saldo restante de payables 'scheduled' sem payment pendente (sem dupla contagem: payable com payment pendente conta só o payment)";
const FORMULA_PROJECTION =
  "projetado(d) = disponível + Σ entradas previstas (recebíveis abertos, saldo restante = amountCents − receivedCents, por dueDate) − Σ saídas previstas (payables abertos/agendados, saldo restante = amountCents − paidCents, por dueDate; com payment pendente usa scheduledDate do payment) até d; títulos vencidos e não liquidados entram na data de hoje";

// ---------------------------------------------------------------------------
// Base de dados consolidada (leitura)
// ---------------------------------------------------------------------------

interface CashBase {
  accounts: BankAccount[];
  accountPositions: AccountPosition[];
  availableCents: number;
  transactions: BankTransaction[];
  payables: Payable[];
  receivables: Receivable[];
  pendingPayments: Payment[];
  pendingByPayable: Map<ID, Payment[]>;
}

async function loadCashBase(ctx: SkillContext): Promise<CashBase> {
  const allAccounts = await ctx.repos.bankAccounts.listAll(ctx.companyId);
  const accounts = allAccounts.filter((a) => a.active);

  const transactions: BankTransaction[] = [];
  const accountPositions: AccountPosition[] = [];
  for (const account of accounts) {
    const txs = await ctx.repos.bankTransactions.listByAccount(ctx.companyId, account.id);
    transactions.push(...txs);
    const movement = txs.reduce((acc, t) => acc + t.amountCents, 0);
    accountPositions.push({
      id: account.id,
      name: account.name,
      availableCents: account.openingBalanceCents + movement,
    });
  }
  const availableCents = accountPositions.reduce((acc, a) => acc + a.availableCents, 0);

  const payables = await ctx.repos.payables.listByStatus(ctx.companyId, [
    ...OPEN_PAYABLE_STATUSES,
  ]);
  const receivables = await ctx.repos.receivables.listByStatus(ctx.companyId, [
    ...OPEN_RECEIVABLE_STATUSES,
  ]);
  const pendingPayments = await ctx.repos.payments.listByStatus(ctx.companyId, [
    ...PENDING_PAYMENT_STATUSES,
  ]);
  const pendingByPayable = new Map<ID, Payment[]>();
  for (const payment of pendingPayments) {
    const list = pendingByPayable.get(payment.payableId) ?? [];
    list.push(payment);
    pendingByPayable.set(payment.payableId, list);
  }

  return {
    accounts,
    accountPositions,
    availableCents,
    transactions,
    payables,
    receivables,
    pendingPayments,
    pendingByPayable,
  };
}

function payableRemainingCents(p: Payable): number {
  return Math.max(0, p.amountCents - p.paidCents);
}

function receivableRemainingCents(r: Receivable): number {
  return Math.max(0, r.amountCents - r.receivedCents);
}

function committedCents(base: CashBase): number {
  const pendingTotal = base.pendingPayments.reduce((acc, p) => acc + p.amountCents, 0);
  const scheduledWithoutPayment = base.payables
    .filter((p) => p.status === "scheduled" && !base.pendingByPayable.has(p.id))
    .reduce((acc, p) => acc + payableRemainingCents(p), 0);
  return pendingTotal + scheduledWithoutPayment;
}

// ---------------------------------------------------------------------------
// Motor de projeção (compartilhado por todas as ações)
// ---------------------------------------------------------------------------

interface FlowItem {
  date: ISODate; // data projetada (nunca antes de hoje)
  amountCents: number; // sempre positivo
  kind: "in" | "out";
  entityType: "receivable" | "payable";
  entityId: ID;
  overdue: boolean;
}

/**
 * Saídas previstas — idênticas em todos os cenários (pagamento é obrigação):
 * saldo restante do payable na dueDate; com payment pendente, na scheduledDate
 * do payment (a mais antiga, se houver mais de um); vencidos entram hoje.
 */
function buildOutflows(base: CashBase, today: ISODate): FlowItem[] {
  const items: FlowItem[] = [];
  for (const payable of base.payables) {
    const remaining = payableRemainingCents(payable);
    if (remaining <= 0) continue;
    const pending = base.pendingByPayable.get(payable.id);
    const referenceDate = pending
      ? pending.map((p) => p.scheduledDate).sort()[0]
      : payable.dueDate;
    const overdue = referenceDate < today;
    items.push({
      date: overdue ? today : referenceDate,
      amountCents: remaining,
      kind: "out",
      entityType: "payable",
      entityId: payable.id,
      overdue,
    });
  }
  return items;
}

/** Entradas previstas com parâmetros de cenário (base determinística: 100%/0/0). */
function buildInflows(base: CashBase, today: ISODate, params: ScenarioParams): FlowItem[] {
  const items: FlowItem[] = [];
  for (const receivable of base.receivables) {
    const remaining = receivableRemainingCents(receivable);
    if (remaining <= 0) continue;
    const overdue = receivable.dueDate < today;
    const date = overdue
      ? addDays(today, params.overdueDelayDays)
      : addDays(receivable.dueDate, params.delayDays);
    items.push({
      date,
      amountCents: percentOf(remaining, params.realizationPercent),
      kind: "in",
      entityType: "receivable",
      entityId: receivable.id,
      overdue,
    });
  }
  return items;
}

const DETERMINISTIC_PARAMS: ScenarioParams = {
  realizationPercent: 100,
  delayDays: 0,
  overdueDelayDays: 0,
};

interface ProjectionResult {
  summary: ProjectionSummary;
  daily: DailyFlowPoint[];
  items: FlowItem[]; // itens dentro do horizonte
}

/** Agrega itens por dia (apenas dias com movimento + hoje) e acumula o saldo. */
function projectDaily(
  items: FlowItem[],
  openingBalanceCents: number,
  today: ISODate,
  horizonDays: number
): ProjectionResult {
  const horizonEnd = addDays(today, horizonDays);
  const inHorizon = items.filter((i) => i.date <= horizonEnd);

  const byDate = new Map<ISODate, { inCents: number; outCents: number }>();
  byDate.set(today, { inCents: 0, outCents: 0 });
  for (const item of inHorizon) {
    const bucket = byDate.get(item.date) ?? { inCents: 0, outCents: 0 };
    if (item.kind === "in") bucket.inCents += item.amountCents;
    else bucket.outCents += item.amountCents;
    byDate.set(item.date, bucket);
  }

  const dates = [...byDate.keys()].sort();
  const daily: DailyFlowPoint[] = [];
  let balance = openingBalanceCents;
  let totalIn = 0;
  let totalOut = 0;
  let minBalance = Number.POSITIVE_INFINITY;
  let minBalanceDate: ISODate = today;
  for (const date of dates) {
    const { inCents, outCents } = byDate.get(date)!;
    balance += inCents - outCents;
    totalIn += inCents;
    totalOut += outCents;
    if (balance < minBalance) {
      minBalance = balance;
      minBalanceDate = date;
    }
    daily.push({ date, inCents, outCents, balanceCents: balance });
  }

  return {
    summary: {
      horizonStart: today,
      horizonEnd,
      openingBalanceCents,
      totalInCents: totalIn,
      totalOutCents: totalOut,
      endingBalanceCents: openingBalanceCents + totalIn - totalOut,
      minBalanceCents: minBalance,
      minBalanceDate,
    },
    daily,
    items: inHorizon,
  };
}

// ---------------------------------------------------------------------------
// Helpers de calendário para o demonstrativo
// ---------------------------------------------------------------------------

/** Segunda-feira da semana que contém a data. */
function weekStart(date: ISODate): ISODate {
  const dow = toUtcNoon(date).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}

const DEFAULT_PERIODS: Record<CashflowGranularity, number> = {
  daily: 30,
  weekly: 8,
  monthly: 12,
};

interface BucketRange {
  label: string;
  start: ISODate;
  end: ISODate;
}

/**
 * Linha do tempo do demonstrativo: floor(periods/2) períodos passados
 * (realizado) + os demais a partir do período corrente (realizado até hoje e
 * projetado à frente).
 */
function buildBucketRanges(
  granularity: CashflowGranularity,
  periods: number,
  today: ISODate
): BucketRange[] {
  const pastCount = Math.floor(periods / 2);
  const ranges: BucketRange[] = [];
  for (let i = 0; i < periods; i++) {
    const offset = i - pastCount; // 0 = período corrente
    if (granularity === "daily") {
      const day = addDays(today, offset);
      ranges.push({ label: formatBR(day), start: day, end: day });
    } else if (granularity === "weekly") {
      const start = addDays(weekStart(today), offset * 7);
      ranges.push({ label: `Semana de ${formatBR(start)}`, start, end: addDays(start, 6) });
    } else {
      const start = addMonths(startOfMonth(monthOf(today)), offset);
      ranges.push({ label: monthOf(start), start, end: endOfMonth(monthOf(start)) });
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Recomendações determinísticas (texto — nunca executam nada)
// ---------------------------------------------------------------------------

function buildRecommendations(
  projection: ProjectionResult,
  minimumCashCents: number
): string[] {
  const recs: string[] = [];
  const { summary, items } = projection;

  if (summary.minBalanceCents < 0) {
    recs.push(
      `Insuficiência projetada de ${formatBRL(summary.minBalanceCents)} em ${formatBR(summary.minBalanceDate)}: antecipar recebíveis em aberto (${formatBRL(summary.totalInCents)} previstos no horizonte) e/ou negociar prorrogação de vencimentos com fornecedores.`
    );
  } else if (summary.minBalanceCents < minimumCashCents) {
    recs.push(
      `Saldo mínimo projetado de ${formatBRL(summary.minBalanceCents)} em ${formatBR(summary.minBalanceDate)} abaixo do caixa mínimo de segurança (${formatBRL(minimumCashCents)}): considerar antecipação de recebíveis ou adiamento de despesas não essenciais.`
    );
  }

  const overdueInCents = items
    .filter((i) => i.kind === "in" && i.overdue)
    .reduce((acc, i) => acc + i.amountCents, 0);
  if (overdueInCents > 0) {
    recs.push(
      `Intensificar cobrança: ${formatBRL(overdueInCents)} em recebíveis vencidos considerados como entrada imediata na projeção.`
    );
  }

  // Semana com maior concentração de saídas (empate: semana mais próxima).
  const outByWeek = new Map<ISODate, number>();
  for (const item of items) {
    if (item.kind !== "out") continue;
    const ws = weekStart(item.date);
    outByWeek.set(ws, (outByWeek.get(ws) ?? 0) + item.amountCents);
  }
  let worstWeek: ISODate | undefined;
  let worstOut = 0;
  for (const ws of [...outByWeek.keys()].sort()) {
    const total = outByWeek.get(ws)!;
    if (total > worstOut) {
      worstOut = total;
      worstWeek = ws;
    }
  }
  if (worstWeek && worstOut > 0) {
    recs.push(
      `Revisar desembolsos da semana de ${formatBR(worstWeek)}: maior concentração de saídas do horizonte (${formatBRL(worstOut)}).`
    );
  }

  if (recs.length === 0) {
    recs.push(
      "Caixa projetado confortável no horizonte: manter acompanhamento diário e aplicar excedentes conforme a política da empresa."
    );
  }
  return recs;
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function executeCashPosition(ctx: SkillContext) {
  const base = await loadCashBase(ctx);
  const today = ctx.today();
  const projection = projectDaily(
    [...buildInflows(base, today, DETERMINISTIC_PARAMS), ...buildOutflows(base, today)],
    base.availableCents,
    today,
    30
  );

  const data: CashPositionData = {
    accounts: base.accountPositions,
    totals: {
      availableCents: base.availableCents,
      committedCents: committedCents(base),
      projected30Cents: projection.summary.endingBalanceCents,
    },
    period: { asOf: today, projectionEnd: projection.summary.horizonEnd },
    formulas: {
      available: FORMULA_AVAILABLE,
      committed: FORMULA_COMMITTED,
      projected30: `${FORMULA_PROJECTION} (horizonte de 30 dias)`,
    },
  };

  return makeResult<TesourariaData>(SKILL_NAME, ctx, data, {
    confidence: 1.0,
    assumptions: [
      "Apenas contas bancárias ativas entram na posição de caixa.",
      "Títulos vencidos e não liquidados são considerados como movimento na data de hoje.",
    ],
    dataSources: [...DATA_SOURCES],
  });
}

async function executeRefreshProjection(ctx: SkillContext, input: RefreshProjectionInput) {
  const base = await loadCashBase(ctx);
  const today = ctx.today();
  const horizonDays = input.horizonDays ?? 90;
  const projection = projectDaily(
    [...buildInflows(base, today, DETERMINISTIC_PARAMS), ...buildOutflows(base, today)],
    base.availableCents,
    today,
    horizonDays
  );
  const { summary } = projection;

  const assumptions: string[] = [
    "Títulos vencidos e não liquidados entram como entrada/saída na data de hoje.",
    "Apenas contas bancárias ativas compõem o saldo disponível de abertura.",
  ];
  const envelopeAlerts: SkillAlert[] = [];

  // Alertas de insuficiência (dedupe por code entre alertas abertos).
  let alertToPersist: Pick<Alert, "severity" | "code" | "message"> | undefined;
  if (summary.minBalanceCents < 0) {
    alertToPersist = {
      severity: "critical",
      code: "cash_shortfall_projected",
      message: `Insuficiência de caixa projetada: saldo mínimo de ${formatBRL(summary.minBalanceCents)} em ${formatBR(summary.minBalanceDate)} (horizonte de ${horizonDays} dias).`,
    };
  } else if (summary.minBalanceCents < ctx.config.minimumCashCents) {
    alertToPersist = {
      severity: "warning",
      code: "cash_below_minimum",
      message: `Saldo projetado abaixo do caixa mínimo: mínimo de ${formatBRL(summary.minBalanceCents)} em ${formatBR(summary.minBalanceDate)}, contra caixa mínimo de segurança de ${formatBRL(ctx.config.minimumCashCents)}.`,
    };
  }

  if (alertToPersist) {
    envelopeAlerts.push({
      severity: alertToPersist.severity,
      code: alertToPersist.code,
      message: alertToPersist.message,
      entityType: "cashflow_projection",
    });
    const open = await ctx.repos.alerts.listOpen(ctx.companyId);
    const existing = open.find((a) => a.code === alertToPersist!.code);
    if (existing) {
      assumptions.push(
        `Alerta '${alertToPersist.code}' já está aberto (${existing.id}); não foi duplicado.`
      );
    } else {
      const alert: Alert = {
        id: ctx.ids.next("alr"),
        companyId: ctx.companyId,
        severity: alertToPersist.severity,
        code: alertToPersist.code,
        message: alertToPersist.message,
        entityType: "cashflow_projection",
        source: SKILL_NAME,
        status: "open",
        createdAt: ctx.clock.now().toISOString(),
      };
      await ctx.repos.alerts.create(alert);
      await ctx.audit.record(ctx.companyId, {
        actor: ctx.actor,
        action: "alert.created",
        entityType: "alert",
        entityId: alert.id,
        after: alert,
        correlationId: ctx.correlationId,
      });
    }
  }

  if (summary.minBalanceCents < 0) {
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "cashflow.shortfall_detected",
      payload: {
        minBalanceCents: summary.minBalanceCents,
        minBalanceDate: summary.minBalanceDate,
        horizonDays,
      },
      source: SKILL_NAME,
      correlationId: ctx.correlationId,
    });
  }
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "cashflow.updated",
    payload: {
      horizonDays,
      horizonStart: summary.horizonStart,
      horizonEnd: summary.horizonEnd,
      endingBalanceCents: summary.endingBalanceCents,
      minBalanceCents: summary.minBalanceCents,
      minBalanceDate: summary.minBalanceDate,
    },
    source: SKILL_NAME,
    correlationId: ctx.correlationId,
  });

  const data: RefreshProjectionData = {
    summary,
    daily: projection.daily,
    recommendations: buildRecommendations(projection, ctx.config.minimumCashCents),
    formulas: { available: FORMULA_AVAILABLE, projection: FORMULA_PROJECTION },
  };

  return makeResult<TesourariaData>(SKILL_NAME, ctx, data, {
    confidence: 1.0,
    alerts: envelopeAlerts,
    assumptions,
    dataSources: [...DATA_SOURCES],
  });
}

async function executeCashflowStatement(ctx: SkillContext, input: CashflowStatementInput) {
  const base = await loadCashBase(ctx);
  const today = ctx.today();
  const periods = input.periods ?? DEFAULT_PERIODS[input.granularity];
  const ranges = buildBucketRanges(input.granularity, periods, today);
  const periodStart = ranges[0].start;
  const periodEnd = ranges[ranges.length - 1].end;

  // Projetado à frente na mesma base do refresh, limitado ao fim do último bucket.
  const projectedItems = [
    ...buildInflows(base, today, DETERMINISTIC_PARAMS),
    ...buildOutflows(base, today),
  ].filter((i) => i.date <= periodEnd);

  // Saldo no início do primeiro bucket = aberturas + transações anteriores a ele.
  const startingBalance =
    base.accounts.reduce((acc, a) => acc + a.openingBalanceCents, 0) +
    base.transactions
      .filter((t) => t.date < periodStart)
      .reduce((acc, t) => acc + t.amountCents, 0);

  const buckets: CashflowBucket[] = [];
  let cumulative = startingBalance;
  for (const range of ranges) {
    // Realizado: transações bancárias (fonte primária declarada) até hoje.
    const realizedWindowEnd = range.end < today ? range.end : today;
    let realizedIn = 0;
    let realizedOut = 0;
    if (range.start <= realizedWindowEnd) {
      for (const tx of base.transactions) {
        if (tx.date < range.start || tx.date > realizedWindowEnd) continue;
        if (tx.amountCents >= 0) realizedIn += tx.amountCents;
        else realizedOut += -tx.amountCents;
      }
    }
    // Projetado: itens da projeção (datas sempre >= hoje) dentro do bucket.
    let projectedIn = 0;
    let projectedOut = 0;
    for (const item of projectedItems) {
      if (item.date < range.start || item.date > range.end) continue;
      if (item.kind === "in") projectedIn += item.amountCents;
      else projectedOut += item.amountCents;
    }
    const net = realizedIn - realizedOut + projectedIn - projectedOut;
    cumulative += net;
    buckets.push({
      label: range.label,
      start: range.start,
      end: range.end,
      realizedInCents: realizedIn,
      realizedOutCents: realizedOut,
      projectedInCents: projectedIn,
      projectedOutCents: projectedOut,
      netCents: net,
      cumulativeBalanceCents: cumulative,
    });
  }

  const data: CashflowStatementData = {
    granularity: input.granularity,
    buckets,
    period: { start: periodStart, end: periodEnd },
    formula: `realizado = transações bancárias importadas (fonte primária do realizado, conciliadas ou não) por período até hoje; projetado = ${FORMULA_PROJECTION}; net = realizadoIn − realizadoOut + projetadoIn − projetadoOut; saldo acumulado parte de Σ aberturas + transações anteriores a ${periodStart}. Linha do tempo: ${Math.floor(periods / 2)} período(s) passado(s) + ${periods - Math.floor(periods / 2)} a partir do período corrente.`,
  };

  return makeResult<TesourariaData>(SKILL_NAME, ctx, data, {
    confidence: 1.0,
    assumptions: [
      "Realizado usa as transações bancárias importadas como fonte primária (receipts e payments executados são refletidos pelo extrato, evitando dupla contagem).",
      "O período corrente combina realizado (até hoje) e projetado (de hoje ao fim do período).",
      "Títulos vencidos e não liquidados entram como projeção na data de hoje.",
    ],
    dataSources: [...DATA_SOURCES],
  });
}

async function executeScenarios(ctx: SkillContext, input: ScenariosInput) {
  const base = await loadCashBase(ctx);
  const today = ctx.today();
  const horizonDays = input.horizonDays ?? 90;
  const outflows = buildOutflows(base, today);

  const results: ScenarioResult[] = (
    Object.entries(SCENARIO_PARAMS) as [ScenarioName, ScenarioParams][]
  ).map(([name, params]) => {
    const projection = projectDaily(
      [...buildInflows(base, today, params), ...outflows],
      base.availableCents,
      today,
      horizonDays
    );
    return {
      name,
      endingBalanceCents: projection.summary.endingBalanceCents,
      minBalanceCents: projection.summary.minBalanceCents,
      minBalanceDate: projection.summary.minBalanceDate,
      params,
    };
  });

  const data: ScenariosData = {
    scenarios: results,
    horizonDays,
    period: { start: today, end: addDays(today, horizonDays) },
    formula:
      "por cenário: entrada = saldo restante × realizationPercent%, na dueDate + delayDays (vencidos: hoje + overdueDelayDays); saídas idênticas nos três cenários (pagamento é obrigação): saldo restante na dueDate ou na scheduledDate do payment pendente, vencidos hoje; saldo final = disponível + Σ entradas − Σ saídas dentro do horizonte",
  };

  return makeResult<TesourariaData>(SKILL_NAME, ctx, data, {
    confidence: 0.6,
    assumptions: [
      "Cenário otimista: 100% das entradas na data prevista; vencidos recebidos em 7 dias.",
      "Cenário base: 95% de realização das entradas com atraso médio de 7 dias; vencidos recebidos em 21 dias.",
      "Cenário pessimista: 80% de realização das entradas com atraso de 21 dias; vencidos recebidos em 45 dias.",
      "Saídas idênticas nos três cenários — pagamento é obrigação.",
      "Entradas deslocadas para além do horizonte deixam de compor o saldo final do cenário.",
    ],
    dataSources: [...DATA_SOURCES],
  });
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const tesourariaSkill: SkillDefinition<TesourariaInput, TesourariaData> = {
  name: SKILL_NAME,
  responsibility:
    "Tesouraria e fluxo de caixa: consolida entradas/saídas, calcula saldos disponível/comprometido/projetado, fluxo diário/semanal/mensal, cenários e alertas de insuficiência. Recomenda ações — nunca movimenta dinheiro.",
  objective:
    "Dar visibilidade determinística e auditável da posição e da projeção de caixa da empresa, antecipando riscos de insuficiência.",
  inputSchema: tesourariaInputSchema,
  consumes: [
    "payable.created",
    "payment.executed",
    "receivable.created",
    "receivable.received",
    "statement.imported",
  ],
  publishes: ["cashflow.updated", "cashflow.shortfall_detected"],
  dataSources: [...DATA_SOURCES],
  async execute(ctx, input) {
    switch (input.action) {
      case "cash_position":
        return executeCashPosition(ctx);
      case "refresh_projection":
        return executeRefreshProjection(ctx, input);
      case "cashflow_statement":
        return executeCashflowStatement(ctx, input);
      case "scenarios":
        return executeScenarios(ctx, input);
    }
  },
};
