/**
 * Skill: Relatórios Gerenciais (relatorios_gerenciais).
 *
 * Responsabilidade: consolidar informações produzidas pelas demais skills
 * lendo os repositórios diretamente (o orquestrador coordena — esta skill
 * NUNCA chama outras skills). Gera resumo diário, fechamento mensal e visão
 * executiva, separando explicitamente no data:
 *  - facts: fatos lidos dos repositórios;
 *  - calculations: cálculos determinísticos com fórmula e período;
 *  - trend (visão executiva): tendência/projeção com premissas declaradas;
 *  - recommendations/risks/opportunities: textos determinísticos derivados de
 *    regras explícitas (documentadas nos comentários e nas fórmulas).
 * Também produz dados achatados prontos para exportação CSV/PDF — a conversão
 * em arquivo é responsabilidade de src/lib/exporters; aqui só saem dados
 * estruturados + texto. Skill somente-leitura: nunca movimenta dinheiro.
 */

import { z } from "zod";
import type { Alert, Approval, Payable, Payment, Receipt, Receivable } from "@/core/entities";
import {
  addDays,
  addMonths,
  endOfMonth,
  formatBR,
  monthOf,
  startOfMonth,
  type ISODate,
  type ISOMonth,
} from "@/core/dates";
import { formatBRL, payableRemainingCents, receivableRemainingCents } from "@/core/money";
import type { ReportNarrative } from "@/core/ai";
import { ValidationError } from "@/core/errors";
import type { AlertSeverity, PendingItem, SkillAlert } from "@/core/types";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";

const SKILL_NAME = "relatorios_gerenciais" as const;

const DATA_SOURCES = [
  "bank_accounts",
  "bank_transactions",
  "payables",
  "receivables",
  "payments",
  "receipts",
  "alerts",
  "approvals",
  "categories",
] as const;

// ---------------------------------------------------------------------------
// Entrada (uma variante por ação)
// ---------------------------------------------------------------------------

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const periodSchema = z
  .string()
  .regex(PERIOD_RE, "Período deve estar no formato YYYY-MM (mês 01-12)");

const dailySummarySchema = z.object({
  action: z.literal("daily_summary"),
});

const monthlyCloseSchema = z.object({
  action: z.literal("monthly_close"),
  period: periodSchema,
});

const executiveOverviewSchema = z.object({
  action: z.literal("executive_overview"),
});

const exportDataSchema = z.object({
  action: z.literal("export_data"),
  report: z.enum(["daily_summary", "monthly_close", "executive_overview"]),
  period: periodSchema.optional(),
});

export const relatoriosInputSchema = z.discriminatedUnion("action", [
  dailySummarySchema,
  monthlyCloseSchema,
  executiveOverviewSchema,
  exportDataSchema,
]);

export type DailySummaryInput = z.infer<typeof dailySummarySchema>;
export type MonthlyCloseInput = z.infer<typeof monthlyCloseSchema>;
export type ExecutiveOverviewInput = z.infer<typeof executiveOverviewSchema>;
export type ExportDataInput = z.infer<typeof exportDataSchema>;
export type RelatoriosInput = z.infer<typeof relatoriosInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface DailySummaryFacts {
  availableCents: number;
  payablesDueTodayCents: number;
  payablesDueTodayCount: number;
  receivablesDueTodayCents: number;
  receivablesDueTodayCount: number;
  overduePayablesCents: number;
  overdueReceivablesCents: number;
  openAlerts: { critical: number; warning: number; info: number };
  pendingApprovals: number;
}

export interface DailySummaryData {
  date: ISODate;
  facts: DailySummaryFacts;
  calculations: {
    projected7dEndingBalanceCents: number;
    formula: string;
    period: { start: ISODate; end: ISODate };
  };
  risks: string[];
  recommendations: string[];
  sources: string[];
  /** Resumo narrativo (IA ou heurística — provider declarado); números oficiais são os do relatório. */
  narrative?: ReportNarrative;
}

export interface MonthlyCloseFacts {
  receiptsCents: number;
  paymentsCents: number;
  newPayablesCents: number;
  newReceivablesCents: number;
  endOfMonthAvailableCents: number;
}

export interface MonthlyCloseData {
  period: ISOMonth;
  facts: MonthlyCloseFacts;
  calculations: {
    netCashFlowCents: number;
    formula: string;
    period: { start: ISODate; end: ISODate };
    dreSimplificada: {
      regime: "caixa";
      receitaCents: number;
      despesasCents: number;
      resultadoCents: number;
      formula: string;
    };
  };
  highlights: string[];
  risks: string[];
  recommendations: string[];
  sources: string[];
  /** Resumo narrativo (IA ou heurística — provider declarado); números oficiais são os do relatório. */
  narrative?: ReportNarrative;
}

export interface ExecutiveKpi {
  code: string;
  label: string;
  value: number;
  unit: "centavos_brl" | "quantidade";
  source: string;
}

export interface ExecutiveMonthFlow {
  month: ISOMonth;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
}

export type TrendDirection = "alta" | "estável" | "queda";

export interface ExecutiveTrend {
  direction: TrendDirection;
  lastMonth: ISOMonth;
  lastMonthInflowsCents: number;
  previousTwoMonthsAvgCents: number;
  /** null quando a média dos 2 meses anteriores é zero (divisão indefinida). */
  variationPercent: number | null;
  thresholdPercent: number;
  formula: string;
  period: { start: ISOMonth; end: ISOMonth };
}

export interface ExecutiveOverviewData {
  asOf: ISODate;
  kpis: ExecutiveKpi[];
  monthlyFlows: ExecutiveMonthFlow[];
  trend: ExecutiveTrend;
  risks: string[];
  opportunities: string[];
  recommendations: string[];
  sources: string[];
  /** Resumo narrativo (IA ou heurística — provider declarado); números oficiais são os do relatório. */
  narrative?: ReportNarrative;
}

/** Linha achatada para o exportador CSV: uma linha por métrica. */
export interface ExportRow {
  metrica: string;
  valor: string | number;
  unidade: string;
  fonte: string;
}

export interface ExportDataData {
  report: "daily_summary" | "monthly_close" | "executive_overview";
  title: string;
  subtitle: string;
  generatedAt: string;
  rows: ExportRow[];
  sources: string[];
}

export type RelatoriosData =
  | DailySummaryData
  | MonthlyCloseData
  | ExecutiveOverviewData
  | ExportDataData;

// ---------------------------------------------------------------------------
// Constantes de regra (explícitas — recomendações são determinísticas)
// ---------------------------------------------------------------------------

const OPEN_PAYABLE_STATUSES = ["open", "scheduled", "partially_paid"] as const;
const OPEN_RECEIVABLE_STATUSES = ["open", "partially_received"] as const;

/** Vencidos acima deste % da carteira em aberto geram risco. */
const OVERDUE_RATIO_THRESHOLD_PERCENT = 10;
/** Limiar da tendência de entradas (±%). */
const TREND_THRESHOLD_PERCENT = 10;

const FORMULA_AVAILABLE =
  "disponível = Σ contas bancárias ativas (openingBalanceCents + Σ transações bancárias importadas da conta)";
const FORMULA_PROJECTED_7D =
  `projetado_7d = disponível + Σ saldo restante de recebíveis em aberto com vencimento até hoje+7 (vencidos entram hoje) − Σ saldo restante de títulos a pagar em aberto com vencimento até hoje+7 (vencidos entram hoje); ${FORMULA_AVAILABLE}`;
const FORMULA_NET_CASH_FLOW =
  "fluxo de caixa líquido = recebimentos (baixas em receipts no período) − pagamentos (payments executados com scheduledDate no período)";
const FORMULA_DRE_CAIXA =
  "DRE simplificada em regime de CAIXA: receita = recebimentos do período; despesas = pagamentos executados do período; resultado = receita − despesas";
const FORMULA_TREND =
  `tendência = entradas (créditos bancários de contas ativas) do último mês vs. média dos 2 meses anteriores; variação% = (último − média) ÷ média × 100; "alta" se variação > +${TREND_THRESHOLD_PERCENT}%, "queda" se variação < −${TREND_THRESHOLD_PERCENT}%, senão "estável"`;

// ---------------------------------------------------------------------------
// Helpers de leitura (somente leitura — sem efeitos colaterais)
// ---------------------------------------------------------------------------

/** % com 1 casa decimal, apenas para exibição (dinheiro permanece inteiro). */
function ratioPercent(partCents: number, wholeCents: number): number {
  return wholeCents > 0 ? Math.round((partCents * 1000) / wholeCents) / 10 : 0;
}

interface BankBase {
  activeAccountIds: Set<string>;
  /** Disponível considerando transações até a data (inclusive); sem limite = todas. */
  availableCents(upTo?: ISODate): number;
}

async function loadBankBase(ctx: SkillContext): Promise<BankBase> {
  const accounts = (await ctx.repos.bankAccounts.listAll(ctx.companyId)).filter((a) => a.active);
  const activeAccountIds = new Set(accounts.map((a) => a.id));
  const txByAccount = new Map<string, { date: ISODate; amountCents: number }[]>();
  for (const account of accounts) {
    const txs = await ctx.repos.bankTransactions.listByAccount(ctx.companyId, account.id);
    txByAccount.set(
      account.id,
      txs.map((t) => ({ date: t.date, amountCents: t.amountCents }))
    );
  }
  return {
    activeAccountIds,
    availableCents(upTo?: ISODate): number {
      let total = 0;
      for (const account of accounts) {
        const movement = (txByAccount.get(account.id) ?? [])
          .filter((t) => !upTo || t.date <= upTo)
          .reduce((acc, t) => acc + t.amountCents, 0);
        total += account.openingBalanceCents + movement;
      }
      return total;
    },
  };
}

// ---------------------------------------------------------------------------
// Resumo diário (cálculo puro)
// ---------------------------------------------------------------------------

const DAILY_SOURCES = [
  "bank_accounts",
  "bank_transactions",
  "payables",
  "receivables",
  "alerts",
  "approvals",
];

interface DailyComputation {
  data: DailySummaryData;
  assumptions: string[];
  pendingApprovalsList: Approval[];
  receivablesPortfolioCents: number;
  payablesPortfolioCents: number;
}

async function computeDailySummary(ctx: SkillContext): Promise<DailyComputation> {
  const today = ctx.today();
  const horizonEnd = addDays(today, 7);
  const bank = await loadBankBase(ctx);
  const availableCents = bank.availableCents();

  const openPayables = await ctx.repos.payables.listByStatus(ctx.companyId, [
    ...OPEN_PAYABLE_STATUSES,
  ]);
  const openReceivables = await ctx.repos.receivables.listByStatus(ctx.companyId, [
    ...OPEN_RECEIVABLE_STATUSES,
  ]);

  const payablesDueToday = openPayables.filter((p) => p.dueDate === today);
  const receivablesDueToday = openReceivables.filter((r) => r.dueDate === today);
  const overduePayablesCents = openPayables
    .filter((p) => p.dueDate < today)
    .reduce((acc, p) => acc + payableRemainingCents(p), 0);
  const overdueReceivablesCents = openReceivables
    .filter((r) => r.dueDate < today)
    .reduce((acc, r) => acc + receivableRemainingCents(r), 0);
  const payablesPortfolioCents = openPayables.reduce((acc, p) => acc + payableRemainingCents(p), 0);
  const receivablesPortfolioCents = openReceivables.reduce(
    (acc, r) => acc + receivableRemainingCents(r),
    0
  );

  const openAlerts = await ctx.repos.alerts.listOpen(ctx.companyId);
  const openAlertCounts: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const alert of openAlerts) openAlertCounts[alert.severity] += 1;

  const pendingApprovalsList = await ctx.repos.approvals.listByStatus(ctx.companyId, ["pending"]);

  // Projeção 7d: vencidos e não liquidados entram como movimento de hoje.
  const inflows7dCents = openReceivables
    .filter((r) => r.dueDate <= horizonEnd)
    .reduce((acc, r) => acc + receivableRemainingCents(r), 0);
  const outflows7dCents = openPayables
    .filter((p) => p.dueDate <= horizonEnd)
    .reduce((acc, p) => acc + payableRemainingCents(p), 0);
  const projected7dEndingBalanceCents = availableCents + inflows7dCents - outflows7dCents;

  // Riscos — regras explícitas:
  // 1) saldo projetado 7d negativo;
  // 2) vencidos > 10% da carteira em aberto (a pagar e a receber, separadamente);
  // 3) aprovações pendentes paradas aguardando decisão.
  const risks: string[] = [];
  if (projected7dEndingBalanceCents < 0) {
    risks.push(
      `Saldo projetado para os próximos 7 dias é negativo (${formatBRL(projected7dEndingBalanceCents)}): risco de insuficiência de caixa até ${formatBR(horizonEnd)}.`
    );
  }
  // Comparação inteira exata: vencidos/carteira > limiar%  ⇔  vencidos×100 > carteira×limiar.
  if (overduePayablesCents * 100 > payablesPortfolioCents * OVERDUE_RATIO_THRESHOLD_PERCENT) {
    risks.push(
      `Títulos a pagar vencidos (${formatBRL(overduePayablesCents)}) representam ${ratioPercent(overduePayablesCents, payablesPortfolioCents)}% da carteira em aberto — acima do limite de ${OVERDUE_RATIO_THRESHOLD_PERCENT}%.`
    );
  }
  if (
    overdueReceivablesCents * 100 >
    receivablesPortfolioCents * OVERDUE_RATIO_THRESHOLD_PERCENT
  ) {
    risks.push(
      `Recebíveis vencidos (${formatBRL(overdueReceivablesCents)}) representam ${ratioPercent(overdueReceivablesCents, receivablesPortfolioCents)}% da carteira em aberto — acima do limite de ${OVERDUE_RATIO_THRESHOLD_PERCENT}%.`
    );
  }
  if (pendingApprovalsList.length > 0) {
    risks.push(
      `${pendingApprovalsList.length} aprovação(ões) pendente(s) aguardando decisão: pagamentos e cobranças podem estar parados.`
    );
  }

  // Recomendações determinísticas derivadas dos mesmos fatos/regras.
  const recommendations: string[] = [];
  if (projected7dEndingBalanceCents < 0) {
    recommendations.push(
      `Antecipar recebíveis e/ou renegociar vencimentos de títulos a pagar para cobrir o caixa projetado negativo de ${formatBRL(projected7dEndingBalanceCents)} em 7 dias.`
    );
  }
  if (overdueReceivablesCents > 0) {
    recommendations.push(
      `Acionar a régua de cobrança: ${formatBRL(overdueReceivablesCents)} em recebíveis vencidos.`
    );
  }
  if (overduePayablesCents > 0) {
    recommendations.push(
      `Regularizar ${formatBRL(overduePayablesCents)} em títulos a pagar vencidos para evitar multas e juros.`
    );
  }
  if (pendingApprovalsList.length > 0) {
    recommendations.push(
      `Decidir as ${pendingApprovalsList.length} aprovação(ões) pendente(s) para destravar pagamentos e cobranças.`
    );
  }
  if (openAlertCounts.critical > 0) {
    recommendations.push(`Tratar ${openAlertCounts.critical} alerta(s) crítico(s) em aberto.`);
  }
  if (recommendations.length === 0) {
    recommendations.push(
      "Sem pendências relevantes hoje: manter a rotina de acompanhamento diário."
    );
  }

  const data: DailySummaryData = {
    date: today,
    facts: {
      availableCents,
      payablesDueTodayCents: payablesDueToday.reduce((acc, p) => acc + payableRemainingCents(p), 0),
      payablesDueTodayCount: payablesDueToday.length,
      receivablesDueTodayCents: receivablesDueToday.reduce(
        (acc, r) => acc + receivableRemainingCents(r),
        0
      ),
      receivablesDueTodayCount: receivablesDueToday.length,
      overduePayablesCents,
      overdueReceivablesCents,
      openAlerts: { ...openAlertCounts },
      pendingApprovals: pendingApprovalsList.length,
    },
    calculations: {
      projected7dEndingBalanceCents,
      formula: FORMULA_PROJECTED_7D,
      period: { start: today, end: horizonEnd },
    },
    risks,
    recommendations,
    sources: [...DAILY_SOURCES],
  };

  return {
    data,
    assumptions: [
      "Valores 'vencem hoje' e 'vencidos' usam o saldo restante dos títulos (valor − liquidado).",
      "Apenas contas bancárias ativas compõem o saldo disponível.",
      "Na projeção de 7 dias, títulos vencidos e não liquidados entram como movimento na data de hoje.",
    ],
    pendingApprovalsList,
    receivablesPortfolioCents,
    payablesPortfolioCents,
  };
}

// ---------------------------------------------------------------------------
// Fechamento mensal (cálculo puro)
// ---------------------------------------------------------------------------

const MONTHLY_SOURCES = [
  "receipts",
  "payments",
  "payables",
  "receivables",
  "bank_accounts",
  "bank_transactions",
  "categories",
];

interface MonthlyComputation {
  data: MonthlyCloseData;
  assumptions: string[];
}

async function computeMonthlyClose(
  ctx: SkillContext,
  period: ISOMonth
): Promise<MonthlyComputation> {
  const start = startOfMonth(period);
  const end = endOfMonth(period);
  const bank = await loadBankBase(ctx);

  const receiptsOfMonth: Receipt[] = await ctx.repos.receipts.listByDateRange(
    ctx.companyId,
    start,
    end
  );
  const executedPayments: Payment[] = (
    await ctx.repos.payments.listByStatus(ctx.companyId, ["executed"])
  ).filter((p) => p.scheduledDate >= start && p.scheduledDate <= end);

  const allPayables = await ctx.repos.payables.listAll(ctx.companyId);
  const allReceivables = await ctx.repos.receivables.listAll(ctx.companyId);
  const payableById = new Map(allPayables.map((p) => [p.id, p]));
  const receivableById = new Map(allReceivables.map((r) => [r.id, r]));

  const receiptsCents = receiptsOfMonth.reduce((acc, r) => acc + r.amountCents, 0);
  const paymentsCents = executedPayments.reduce((acc, p) => acc + p.amountCents, 0);
  const newPayablesCents = allPayables
    .filter((p) => p.status !== "canceled" && p.issueDate >= start && p.issueDate <= end)
    .reduce((acc, p) => acc + p.amountCents, 0);
  const newReceivablesCents = allReceivables
    .filter((r) => r.status !== "canceled" && r.issueDate >= start && r.issueDate <= end)
    .reduce((acc, r) => acc + r.amountCents, 0);
  const endOfMonthAvailableCents = bank.availableCents(end);
  const netCashFlowCents = receiptsCents - paymentsCents;

  // Destaques determinísticos: maiores liquidações e top 3 categorias de despesa.
  const highlights: string[] = [];
  const largestPayment = [...executedPayments].sort(
    (a, b) =>
      b.amountCents - a.amountCents ||
      a.scheduledDate.localeCompare(b.scheduledDate) ||
      a.id.localeCompare(b.id)
  )[0];
  if (largestPayment) {
    const desc = payableById.get(largestPayment.payableId)?.description ?? "título a pagar";
    highlights.push(
      `Maior pagamento do mês: ${formatBRL(largestPayment.amountCents)} (${desc}) em ${formatBR(largestPayment.scheduledDate)}.`
    );
  } else {
    highlights.push("Nenhum pagamento executado registrado no mês.");
  }
  const largestReceipt = [...receiptsOfMonth].sort(
    (a, b) =>
      b.amountCents - a.amountCents ||
      a.receivedDate.localeCompare(b.receivedDate) ||
      a.id.localeCompare(b.id)
  )[0];
  if (largestReceipt) {
    const desc = receivableById.get(largestReceipt.receivableId)?.description ?? "recebível";
    highlights.push(
      `Maior recebimento do mês: ${formatBRL(largestReceipt.amountCents)} (${desc}) em ${formatBR(largestReceipt.receivedDate)}.`
    );
  } else {
    highlights.push("Nenhum recebimento registrado no mês.");
  }

  const categories = await ctx.repos.categories.listAll(ctx.companyId);
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const expenseByCategory = new Map<string, number>();
  for (const payment of executedPayments) {
    const categoryId = payableById.get(payment.payableId)?.categoryId;
    const name = categoryId ? (categoryNameById.get(categoryId) ?? "Sem categoria") : "Sem categoria";
    expenseByCategory.set(name, (expenseByCategory.get(name) ?? 0) + payment.amountCents);
  }
  const topCategories = [...expenseByCategory.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3);
  if (topCategories.length > 0) {
    highlights.push(
      `Top categorias de despesa: ${topCategories
        .map(([name, cents], i) => `${i + 1}) ${name} (${formatBRL(cents)})`)
        .join("; ")}.`
    );
  }

  // Riscos — regras explícitas do fechamento:
  // 1) resultado de caixa negativo; 2) saldo final abaixo do caixa mínimo;
  // 3) novos títulos a pagar superam novos títulos a receber.
  const risks: string[] = [];
  if (netCashFlowCents < 0) {
    risks.push(
      `Resultado de caixa negativo no mês (${formatBRL(netCashFlowCents)}): pagamentos superaram recebimentos.`
    );
  }
  if (endOfMonthAvailableCents < ctx.config.minimumCashCents) {
    risks.push(
      `Saldo disponível ao fim do mês (${formatBRL(endOfMonthAvailableCents)}) abaixo do caixa mínimo de segurança (${formatBRL(ctx.config.minimumCashCents)}).`
    );
  }
  if (newPayablesCents > newReceivablesCents) {
    risks.push(
      `Novos títulos a pagar (${formatBRL(newPayablesCents)}) superam novos títulos a receber (${formatBRL(newReceivablesCents)}): pressão futura sobre o caixa.`
    );
  }

  const recommendations: string[] = [];
  if (netCashFlowCents < 0) {
    const topName = topCategories[0]?.[0];
    recommendations.push(
      topName
        ? `Revisar as maiores categorias de despesa (principal: ${topName}) e renegociar prazos com fornecedores.`
        : "Revisar despesas do mês e renegociar prazos com fornecedores."
    );
  }
  if (endOfMonthAvailableCents < ctx.config.minimumCashCents) {
    recommendations.push(
      "Reforçar o caixa: antecipar recebíveis, reduzir desembolsos não essenciais e reavaliar o cronograma de pagamentos."
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      "Manter a disciplina de fechamento mensal e comparar com o orçado vs. realizado da controladoria."
    );
  }

  const data: MonthlyCloseData = {
    period,
    facts: {
      receiptsCents,
      paymentsCents,
      newPayablesCents,
      newReceivablesCents,
      endOfMonthAvailableCents,
    },
    calculations: {
      netCashFlowCents,
      formula: FORMULA_NET_CASH_FLOW,
      period: { start, end },
      dreSimplificada: {
        regime: "caixa",
        receitaCents: receiptsCents,
        despesasCents: paymentsCents,
        resultadoCents: netCashFlowCents,
        formula: FORMULA_DRE_CAIXA,
      },
    },
    highlights,
    risks,
    recommendations,
    sources: [...MONTHLY_SOURCES],
  };

  return {
    data,
    assumptions: [
      "DRE simplificada em regime de CAIXA (receita = recebimentos; despesas = pagamentos do mês) — difere do DRE por competência produzido pela controladoria (controladoria_indicadores).",
      "Data de caixa dos pagamentos executados = scheduledDate do pagamento.",
      "Títulos novos do mês apurados pela data de emissão (issueDate), excluindo cancelados.",
      "Saldo ao fim do mês = aberturas das contas ativas + transações bancárias até o último dia do período.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Visão executiva (cálculo puro)
// ---------------------------------------------------------------------------

const EXECUTIVE_SOURCES = [
  "bank_accounts",
  "bank_transactions",
  "payables",
  "receivables",
  "approvals",
  "alerts",
];

interface ExecutiveComputation {
  data: ExecutiveOverviewData;
  assumptions: string[];
}

async function computeExecutiveOverview(ctx: SkillContext): Promise<ExecutiveComputation> {
  const today = ctx.today();
  const bank = await loadBankBase(ctx);
  const availableCents = bank.availableCents();

  // Últimos 3 meses (o mês corrente, possivelmente parcial, é o último).
  const currentMonthStart = startOfMonth(monthOf(today));
  const months: ISOMonth[] = [
    monthOf(addMonths(currentMonthStart, -2)),
    monthOf(addMonths(currentMonthStart, -1)),
    monthOf(today),
  ];
  const monthlyFlows: ExecutiveMonthFlow[] = [];
  for (const month of months) {
    const txs = (
      await ctx.repos.bankTransactions.listByDateRange(
        ctx.companyId,
        startOfMonth(month),
        endOfMonth(month)
      )
    ).filter((t) => bank.activeAccountIds.has(t.bankAccountId));
    let inflowsCents = 0;
    let outflowsCents = 0;
    for (const tx of txs) {
      if (tx.amountCents >= 0) inflowsCents += tx.amountCents;
      else outflowsCents += -tx.amountCents;
    }
    monthlyFlows.push({ month, inflowsCents, outflowsCents, netCents: inflowsCents - outflowsCents });
  }

  const lastFlow = monthlyFlows[2];
  const previousSumCents = monthlyFlows[0].inflowsCents + monthlyFlows[1].inflowsCents;
  const previousAvgCents = Math.round(previousSumCents / 2);
  // Classificação com aritmética inteira exata:
  // alta  ⇔ último > média×1,1  ⇔ último×20 > soma_2_anteriores×11
  // queda ⇔ último < média×0,9  ⇔ último×20 < soma_2_anteriores×9
  let direction: TrendDirection;
  if (previousSumCents === 0) {
    direction = lastFlow.inflowsCents > 0 ? "alta" : "estável";
  } else if (lastFlow.inflowsCents * 20 > previousSumCents * 11) {
    direction = "alta";
  } else if (lastFlow.inflowsCents * 20 < previousSumCents * 9) {
    direction = "queda";
  } else {
    direction = "estável";
  }
  const variationPercent =
    previousSumCents > 0
      ? Math.round(((lastFlow.inflowsCents - previousSumCents / 2) / (previousSumCents / 2)) * 1000) /
        10
      : null;

  const trend: ExecutiveTrend = {
    direction,
    lastMonth: lastFlow.month,
    lastMonthInflowsCents: lastFlow.inflowsCents,
    previousTwoMonthsAvgCents: previousAvgCents,
    variationPercent,
    thresholdPercent: TREND_THRESHOLD_PERCENT,
    formula: FORMULA_TREND,
    period: { start: months[0], end: months[2] },
  };

  const openPayables = await ctx.repos.payables.listByStatus(ctx.companyId, [
    ...OPEN_PAYABLE_STATUSES,
  ]);
  const openReceivables = await ctx.repos.receivables.listByStatus(ctx.companyId, [
    ...OPEN_RECEIVABLE_STATUSES,
  ]);
  const overduePayablesCents = openPayables
    .filter((p) => p.dueDate < today)
    .reduce((acc, p) => acc + payableRemainingCents(p), 0);
  const overdueReceivablesCents = openReceivables
    .filter((r) => r.dueDate < today)
    .reduce((acc, r) => acc + receivableRemainingCents(r), 0);
  const pendingApprovalsCount = (
    await ctx.repos.approvals.listByStatus(ctx.companyId, ["pending"])
  ).length;
  const criticalAlertsCount = (await ctx.repos.alerts.listOpen(ctx.companyId)).filter(
    (a) => a.severity === "critical"
  ).length;

  const kpis: ExecutiveKpi[] = [
    {
      code: "saldo_disponivel",
      label: "Saldo disponível",
      value: availableCents,
      unit: "centavos_brl",
      source: "bank_accounts, bank_transactions",
    },
    {
      code: "entradas_ultimo_mes",
      label: `Entradas de ${lastFlow.month}`,
      value: lastFlow.inflowsCents,
      unit: "centavos_brl",
      source: "bank_transactions",
    },
    {
      code: "saidas_ultimo_mes",
      label: `Saídas de ${lastFlow.month}`,
      value: lastFlow.outflowsCents,
      unit: "centavos_brl",
      source: "bank_transactions",
    },
    {
      code: "vencidos_a_receber",
      label: "Recebíveis vencidos",
      value: overdueReceivablesCents,
      unit: "centavos_brl",
      source: "receivables",
    },
    {
      code: "vencidos_a_pagar",
      label: "Títulos a pagar vencidos",
      value: overduePayablesCents,
      unit: "centavos_brl",
      source: "payables",
    },
    {
      code: "aprovacoes_pendentes",
      label: "Aprovações pendentes",
      value: pendingApprovalsCount,
      unit: "quantidade",
      source: "approvals",
    },
    {
      code: "alertas_criticos_abertos",
      label: "Alertas críticos abertos",
      value: criticalAlertsCount,
      unit: "quantidade",
      source: "alerts",
    },
  ];

  // Riscos — regras explícitas da visão executiva.
  const risks: string[] = [];
  if (direction === "queda") {
    risks.push(
      `Tendência de queda nas entradas: ${lastFlow.month} teve ${formatBRL(lastFlow.inflowsCents)}, ${variationPercent ?? 0}% vs. a média dos 2 meses anteriores (${formatBRL(previousAvgCents)}).`
    );
  }
  if (availableCents < ctx.config.minimumCashCents) {
    risks.push(
      `Posição de caixa (${formatBRL(availableCents)}) abaixo do caixa mínimo de segurança (${formatBRL(ctx.config.minimumCashCents)}).`
    );
  }
  if (overdueReceivablesCents > 0) {
    risks.push(`Recebíveis vencidos em carteira: ${formatBRL(overdueReceivablesCents)}.`);
  }
  if (criticalAlertsCount > 0) {
    risks.push(`${criticalAlertsCount} alerta(s) crítico(s) em aberto sem tratamento.`);
  }
  if (pendingApprovalsCount > 0) {
    risks.push(`${pendingApprovalsCount} aprovação(ões) pendente(s) aguardando decisão.`);
  }

  // Oportunidades — regras explícitas.
  const opportunities: string[] = [];
  if (direction === "alta") {
    opportunities.push(
      `Tendência de alta nas entradas (+${variationPercent ?? 0}% vs. média dos 2 meses anteriores): avaliar investimentos planejados e reposição de estoque.`
    );
  }
  if (availableCents >= 2 * ctx.config.minimumCashCents) {
    opportunities.push(
      `Excedente de caixa (${formatBRL(availableCents)} disponíveis, acima do dobro do caixa mínimo): avaliar aplicação financeira do excedente.`
    );
  }
  if (overdueReceivablesCents > 0) {
    opportunities.push(
      `Recuperar ${formatBRL(overdueReceivablesCents)} em recebíveis vencidos via régua de cobrança elevaria o caixa disponível.`
    );
  }
  if (opportunities.length === 0) {
    opportunities.push("Nenhuma oportunidade identificada pelas regras atuais.");
  }

  const recommendations: string[] = [];
  if (direction === "queda") {
    recommendations.push(
      "Investigar a queda das entradas com o comercial e reforçar a cobrança dos recebíveis em aberto."
    );
  }
  if (pendingApprovalsCount > 0) {
    recommendations.push("Decidir as aprovações pendentes para destravar a operação financeira.");
  }
  if (criticalAlertsCount > 0) {
    recommendations.push("Priorizar o tratamento dos alertas críticos abertos.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Manter o acompanhamento executivo mensal dos indicadores.");
  }

  const data: ExecutiveOverviewData = {
    asOf: today,
    kpis,
    monthlyFlows,
    trend,
    risks,
    opportunities,
    recommendations,
    sources: [...EXECUTIVE_SOURCES],
  };

  return {
    data,
    assumptions: [
      "O mês corrente pode estar parcial: a tendência compara o mês corrente com a média dos 2 meses anteriores.",
      "Entradas/saídas realizadas apuradas pelas transações bancárias importadas de contas ativas.",
      `Classificação da tendência é regra determinística com limiar de ±${TREND_THRESHOLD_PERCENT}%, mas a leitura de tendência é heurística (confiança < 1).`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Efeitos colaterais compartilhados (alerta persistido com dedupe, evento, auditoria)
// ---------------------------------------------------------------------------

interface AlertSpec {
  severity: AlertSeverity;
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

/** Persiste o alerta apenas se não houver outro aberto com o mesmo código (idempotência). */
async function persistAlertOnce(
  ctx: SkillContext,
  spec: AlertSpec,
  assumptions: string[]
): Promise<void> {
  const open = await ctx.repos.alerts.listOpen(ctx.companyId);
  const existing = open.find((a) => a.code === spec.code && a.source === SKILL_NAME);
  if (existing) {
    assumptions.push(`Alerta '${spec.code}' já está aberto (${existing.id}); não foi duplicado.`);
    return;
  }
  const alert: Alert = {
    id: ctx.ids.next("alr"),
    companyId: ctx.companyId,
    severity: spec.severity,
    code: spec.code,
    message: spec.message,
    entityType: spec.entityType,
    entityId: spec.entityId,
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

async function registerReportGeneration(
  ctx: SkillContext,
  report: string,
  ref: Record<string, unknown>
): Promise<string> {
  const reportId = ctx.ids.next("rpt");
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "report.generated",
    payload: { reportId, report, ...ref },
    source: SKILL_NAME,
    correlationId: ctx.correlationId,
  });
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "report.generated",
    entityType: "report",
    entityId: reportId,
    after: { report, ...ref },
    correlationId: ctx.correlationId,
  });
  return reportId;
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

/** Transparência do resumo narrativo em toda resposta que o inclui. */
const NARRATIVE_ASSUMPTION = (provider: string): string =>
  `Resumo narrativo gerado por "${provider}" APENAS a partir dos fatos determinísticos do relatório — os números oficiais são os calculados pela skill, nunca os do texto.`;

async function executeDailySummary(ctx: SkillContext) {
  const computation = await computeDailySummary(ctx);
  const { data } = computation;
  const assumptions = [...computation.assumptions];

  const envelopeAlerts: SkillAlert[] = [];
  if (data.calculations.projected7dEndingBalanceCents < 0) {
    const spec: AlertSpec = {
      severity: "critical",
      code: "report_cash_risk_7d",
      message: `Resumo diário: saldo projetado para 7 dias é negativo (${formatBRL(data.calculations.projected7dEndingBalanceCents)}).`,
      entityType: "report",
    };
    envelopeAlerts.push({ ...spec });
    await persistAlertOnce(ctx, spec, assumptions);
  }
  if (
    data.facts.overduePayablesCents * 100 >
    computation.payablesPortfolioCents * OVERDUE_RATIO_THRESHOLD_PERCENT
  ) {
    envelopeAlerts.push({
      severity: "warning",
      code: "overdue_payables_ratio_high",
      message: `Títulos a pagar vencidos acima de ${OVERDUE_RATIO_THRESHOLD_PERCENT}% da carteira em aberto.`,
    });
  }
  if (
    data.facts.overdueReceivablesCents * 100 >
    computation.receivablesPortfolioCents * OVERDUE_RATIO_THRESHOLD_PERCENT
  ) {
    envelopeAlerts.push({
      severity: "warning",
      code: "overdue_receivables_ratio_high",
      message: `Recebíveis vencidos acima de ${OVERDUE_RATIO_THRESHOLD_PERCENT}% da carteira em aberto.`,
    });
  }

  const pendingItems: PendingItem[] = computation.pendingApprovalsList.map((a) => ({
    code: "aprovacao_pendente",
    description: `Aprovação pendente: ${a.summary}`,
    entityType: "approval",
    entityId: a.id,
    suggestedAction: "Decidir a aprovação no painel de aprovações.",
  }));

  await registerReportGeneration(ctx, "daily_summary", { date: data.date });

  data.narrative = await ctx.ai.narrateReport({
    reportType: "daily_summary",
    periodLabel: formatBR(data.date),
    facts: [
      { label: "saldo disponível", value: formatBRL(data.facts.availableCents) },
      {
        label: "a pagar hoje",
        value: `${formatBRL(data.facts.payablesDueTodayCents)} (${data.facts.payablesDueTodayCount} título(s))`,
      },
      {
        label: "a receber hoje",
        value: `${formatBRL(data.facts.receivablesDueTodayCents)} (${data.facts.receivablesDueTodayCount} título(s))`,
      },
      { label: "vencidos a pagar", value: formatBRL(data.facts.overduePayablesCents) },
      { label: "vencidos a receber", value: formatBRL(data.facts.overdueReceivablesCents) },
      {
        label: "saldo projetado em 7 dias",
        value: formatBRL(data.calculations.projected7dEndingBalanceCents),
      },
    ],
    risks: data.risks,
    recommendations: data.recommendations,
  });
  assumptions.push(NARRATIVE_ASSUMPTION(data.narrative.provider));

  return makeResult<RelatoriosData>(SKILL_NAME, ctx, data, {
    confidence: 1.0,
    alerts: envelopeAlerts,
    pendingItems,
    assumptions,
    dataSources: [...DAILY_SOURCES],
  });
}

async function executeMonthlyClose(ctx: SkillContext, input: MonthlyCloseInput) {
  const computation = await computeMonthlyClose(ctx, input.period);
  const { data } = computation;

  const envelopeAlerts: SkillAlert[] = [];
  if (data.calculations.dreSimplificada.resultadoCents < 0) {
    envelopeAlerts.push({
      severity: "warning",
      code: "monthly_negative_result",
      message: `Fechamento ${data.period}: resultado de caixa negativo (${formatBRL(data.calculations.dreSimplificada.resultadoCents)}).`,
    });
  }
  if (data.facts.endOfMonthAvailableCents < ctx.config.minimumCashCents) {
    envelopeAlerts.push({
      severity: "warning",
      code: "monthly_cash_below_minimum",
      message: `Fechamento ${data.period}: saldo final abaixo do caixa mínimo de segurança.`,
    });
  }

  await registerReportGeneration(ctx, "monthly_close", { period: data.period });

  data.narrative = await ctx.ai.narrateReport({
    reportType: "monthly_close",
    periodLabel: data.period,
    facts: [
      { label: "recebimentos", value: formatBRL(data.facts.receiptsCents) },
      { label: "pagamentos", value: formatBRL(data.facts.paymentsCents) },
      { label: "fluxo de caixa líquido", value: formatBRL(data.calculations.netCashFlowCents) },
      {
        label: "resultado (DRE de caixa)",
        value: formatBRL(data.calculations.dreSimplificada.resultadoCents),
      },
      { label: "saldo ao fim do mês", value: formatBRL(data.facts.endOfMonthAvailableCents) },
    ],
    risks: data.risks,
    recommendations: data.recommendations,
  });
  const monthlyAssumptions = [
    ...computation.assumptions,
    NARRATIVE_ASSUMPTION(data.narrative.provider),
  ];

  return makeResult<RelatoriosData>(SKILL_NAME, ctx, data, {
    confidence: 1.0,
    alerts: envelopeAlerts,
    assumptions: monthlyAssumptions,
    dataSources: [...MONTHLY_SOURCES],
  });
}

async function executeExecutiveOverview(ctx: SkillContext) {
  const computation = await computeExecutiveOverview(ctx);
  const { data } = computation;
  const assumptions = [...computation.assumptions];

  const envelopeAlerts: SkillAlert[] = [];
  if (data.trend.direction === "queda") {
    const spec: AlertSpec = {
      severity: "warning",
      code: "report_revenue_trend_down",
      message: `Visão executiva: tendência de queda nas entradas em ${data.trend.lastMonth} (${data.trend.variationPercent ?? 0}% vs. média dos 2 meses anteriores).`,
      entityType: "report",
    };
    envelopeAlerts.push({ ...spec });
    await persistAlertOnce(ctx, spec, assumptions);
  }

  await registerReportGeneration(ctx, "executive_overview", { asOf: data.asOf });

  data.narrative = await ctx.ai.narrateReport({
    reportType: "executive_overview",
    periodLabel: formatBR(data.asOf),
    facts: [
      ...data.kpis.slice(0, 5).map((k) => ({
        label: k.label.toLowerCase(),
        value: k.unit === "centavos_brl" ? formatBRL(k.value) : String(k.value),
      })),
      {
        label: "tendência de entradas",
        value: `${data.trend.direction}${data.trend.variationPercent !== null ? ` (${data.trend.variationPercent}% vs. média dos 2 meses anteriores)` : ""}`,
      },
    ],
    risks: data.risks,
    recommendations: data.recommendations,
  });
  assumptions.push(NARRATIVE_ASSUMPTION(data.narrative.provider));

  // Tendência é leitura heurística sobre dados possivelmente parciais.
  return makeResult<RelatoriosData>(SKILL_NAME, ctx, data, {
    confidence: 0.9,
    alerts: envelopeAlerts,
    assumptions,
    dataSources: [...EXECUTIVE_SOURCES],
  });
}

// ---------------------------------------------------------------------------
// Exportação (dados achatados para CSV/PDF — conversão em arquivo: src/lib/exporters)
// ---------------------------------------------------------------------------

const RULES_SOURCE = "regras determinísticas (relatorios_gerenciais)";

function moneyRow(metrica: string, valorCents: number, fonte: string): ExportRow {
  return { metrica, valor: valorCents, unidade: "centavos (BRL)", fonte };
}

function countRow(metrica: string, valor: number, fonte: string): ExportRow {
  return { metrica, valor, unidade: "quantidade", fonte };
}

function textRows(prefix: string, texts: string[], fonte: string): ExportRow[] {
  return texts.map((t, i) => ({
    metrica: `${prefix}_${i + 1}`,
    valor: t,
    unidade: "texto",
    fonte,
  }));
}

function flattenDailySummary(data: DailySummaryData): ExportRow[] {
  const f = data.facts;
  return [
    { metrica: "data_referencia", valor: data.date, unidade: "data (YYYY-MM-DD)", fonte: "relógio no fuso da empresa" },
    moneyRow("saldo_disponivel", f.availableCents, "bank_accounts, bank_transactions"),
    moneyRow("contas_a_pagar_hoje_valor", f.payablesDueTodayCents, "payables"),
    countRow("contas_a_pagar_hoje_quantidade", f.payablesDueTodayCount, "payables"),
    moneyRow("contas_a_receber_hoje_valor", f.receivablesDueTodayCents, "receivables"),
    countRow("contas_a_receber_hoje_quantidade", f.receivablesDueTodayCount, "receivables"),
    moneyRow("vencidos_a_pagar", f.overduePayablesCents, "payables"),
    moneyRow("vencidos_a_receber", f.overdueReceivablesCents, "receivables"),
    countRow("alertas_abertos_criticos", f.openAlerts.critical, "alerts"),
    countRow("alertas_abertos_avisos", f.openAlerts.warning, "alerts"),
    countRow("alertas_abertos_informativos", f.openAlerts.info, "alerts"),
    countRow("aprovacoes_pendentes", f.pendingApprovals, "approvals"),
    moneyRow(
      "saldo_projetado_7d",
      data.calculations.projected7dEndingBalanceCents,
      "cálculo determinístico (bank_accounts, bank_transactions, payables, receivables)"
    ),
    ...textRows("risco", data.risks, RULES_SOURCE),
    ...textRows("recomendacao", data.recommendations, RULES_SOURCE),
  ];
}

function flattenMonthlyClose(data: MonthlyCloseData): ExportRow[] {
  const f = data.facts;
  const dre = data.calculations.dreSimplificada;
  return [
    { metrica: "periodo", valor: data.period, unidade: "mês (YYYY-MM)", fonte: "parâmetro do relatório" },
    moneyRow("recebimentos", f.receiptsCents, "receipts"),
    moneyRow("pagamentos", f.paymentsCents, "payments"),
    moneyRow("novos_titulos_a_pagar", f.newPayablesCents, "payables"),
    moneyRow("novos_titulos_a_receber", f.newReceivablesCents, "receivables"),
    moneyRow("saldo_disponivel_fim_do_mes", f.endOfMonthAvailableCents, "bank_accounts, bank_transactions"),
    moneyRow("fluxo_caixa_liquido", data.calculations.netCashFlowCents, "cálculo determinístico (receipts, payments)"),
    moneyRow("dre_caixa_receita", dre.receitaCents, "receipts"),
    moneyRow("dre_caixa_despesas", dre.despesasCents, "payments"),
    moneyRow("dre_caixa_resultado", dre.resultadoCents, "cálculo determinístico (receipts, payments)"),
    ...textRows("destaque", data.highlights, RULES_SOURCE),
    ...textRows("risco", data.risks, RULES_SOURCE),
    ...textRows("recomendacao", data.recommendations, RULES_SOURCE),
  ];
}

function flattenExecutiveOverview(data: ExecutiveOverviewData): ExportRow[] {
  const rows: ExportRow[] = [
    { metrica: "posicao_em", valor: data.asOf, unidade: "data (YYYY-MM-DD)", fonte: "relógio no fuso da empresa" },
  ];
  for (const kpi of data.kpis) {
    rows.push({
      metrica: kpi.code,
      valor: kpi.value,
      unidade: kpi.unit === "centavos_brl" ? "centavos (BRL)" : "quantidade",
      fonte: kpi.source,
    });
  }
  for (const flow of data.monthlyFlows) {
    rows.push(moneyRow(`entradas_${flow.month}`, flow.inflowsCents, "bank_transactions"));
    rows.push(moneyRow(`saidas_${flow.month}`, flow.outflowsCents, "bank_transactions"));
    rows.push(moneyRow(`liquido_${flow.month}`, flow.netCents, "bank_transactions"));
  }
  rows.push({
    metrica: "tendencia_direcao",
    valor: data.trend.direction,
    unidade: "texto",
    fonte: "cálculo determinístico (bank_transactions)",
  });
  rows.push({
    metrica: "tendencia_variacao_percentual",
    valor: data.trend.variationPercent ?? "n/d",
    unidade: "%",
    fonte: "cálculo determinístico (bank_transactions)",
  });
  rows.push(
    ...textRows("risco", data.risks, RULES_SOURCE),
    ...textRows("oportunidade", data.opportunities, RULES_SOURCE),
    ...textRows("recomendacao", data.recommendations, RULES_SOURCE)
  );
  return rows;
}

async function executeExportData(ctx: SkillContext, input: ExportDataInput) {
  const company = await ctx.repos.companies.getById(ctx.companyId);
  const companyName = company?.name ?? "Empresa";
  const assumptions: string[] = [
    "Linhas achatadas (uma por métrica) prontas para o exportador CSV; título/subtítulo prontos para o PDF. A conversão em arquivo é feita por src/lib/exporters.",
  ];

  let rows: ExportRow[];
  let title: string;
  let subtitle: string;
  let confidence = 1.0;
  let sources: string[];

  if (input.report === "monthly_close") {
    if (!input.period) {
      throw new ValidationError(
        "Período (YYYY-MM) é obrigatório para exportar o relatório monthly_close."
      );
    }
    const computation = await computeMonthlyClose(ctx, input.period);
    rows = flattenMonthlyClose(computation.data);
    title = "Fechamento mensal";
    subtitle = `${companyName} — período ${input.period}`;
    sources = computation.data.sources;
    assumptions.push(...computation.assumptions);
  } else if (input.report === "daily_summary") {
    if (input.period) {
      assumptions.push(
        "Parâmetro 'period' ignorado: o resumo diário é sempre da data de hoje no fuso da empresa."
      );
    }
    const computation = await computeDailySummary(ctx);
    rows = flattenDailySummary(computation.data);
    title = "Resumo diário";
    subtitle = `${companyName} — ${formatBR(computation.data.date)}`;
    sources = computation.data.sources;
    assumptions.push(...computation.assumptions);
  } else {
    if (input.period) {
      assumptions.push(
        "Parâmetro 'period' ignorado: a visão executiva usa sempre os últimos 3 meses até hoje."
      );
    }
    const computation = await computeExecutiveOverview(ctx);
    rows = flattenExecutiveOverview(computation.data);
    title = "Visão executiva";
    subtitle = `${companyName} — posição em ${formatBR(computation.data.asOf)}`;
    sources = computation.data.sources;
    assumptions.push(...computation.assumptions);
    confidence = 0.9; // herda a confiança heurística da tendência
  }

  const data: ExportDataData = {
    report: input.report,
    title,
    subtitle,
    generatedAt: ctx.clock.now().toISOString(),
    rows,
    sources,
  };

  await registerReportGeneration(ctx, "export_data", {
    exportedReport: input.report,
    period: input.period,
  });

  return makeResult<RelatoriosData>(SKILL_NAME, ctx, data, {
    confidence,
    assumptions,
    dataSources: sources,
  });
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const relatoriosSkill: SkillDefinition<RelatoriosInput, RelatoriosData> = {
  name: SKILL_NAME,
  responsibility:
    "Relatórios gerenciais: consolida informações das demais skills lendo os repositórios diretamente; produz resumo diário, fechamento mensal e visão executiva com fatos, cálculos, tendências, riscos, oportunidades e recomendações determinísticas, além de dados prontos para exportação CSV/PDF. Somente leitura — nunca movimenta dinheiro.",
  objective:
    "Dar ao gestor uma visão consolidada, auditável e acionável da situação financeira da empresa, com fórmulas e fontes explícitas em todo cálculo.",
  inputSchema: relatoriosInputSchema,
  consumes: [],
  publishes: ["report.generated"],
  dataSources: [...DATA_SOURCES],
  async execute(ctx, input) {
    switch (input.action) {
      case "daily_summary":
        return executeDailySummary(ctx);
      case "monthly_close":
        return executeMonthlyClose(ctx, input);
      case "executive_overview":
        return executeExecutiveOverview(ctx);
      case "export_data":
        return executeExportData(ctx, input);
    }
  },
};
