/**
 * Skill CONTROLADORIA E INDICADORES — DRE gerencial por competência, margens,
 * EBITDA gerencial, ponto de equilíbrio, capital de giro, ciclo financeiro,
 * estrutura de custos fixos vs. variáveis e explicações em linguagem simples.
 *
 * Tudo determinístico: cada cálculo devolve fórmula, período e fontes.
 * A skill é somente leitura sobre os títulos — não movimenta dinheiro nem
 * exige aprovação humana (nenhuma ação sensível).
 */

import { z } from "zod";
import { addDays, monthOf, type ISODate, type ISOMonth } from "@/core/dates";
import type { Category, DreGroup, ID, Payable, Receivable } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import { formatBRL } from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL = "controladoria_indicadores" as const;
const DATA_SOURCES = ["payables", "receivables", "categories", "receipts", "payments"];

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "período inválido (esperado YYYY-MM)" });

const dreSchema = z.object({
  action: z.literal("dre"),
  period: periodSchema,
});

const indicatorsSchema = z.object({
  action: z.literal("indicators"),
  period: periodSchema,
});

const costStructureSchema = z.object({
  action: z.literal("cost_structure"),
  period: periodSchema,
});

const explainIndicatorSchema = z.object({
  action: z.literal("explain_indicator"),
  indicator: z.string().min(1),
});

export const controladoriaInputSchema = z.discriminatedUnion("action", [
  dreSchema,
  indicatorsSchema,
  costStructureSchema,
  explainIndicatorSchema,
]);

export type DreInput = z.infer<typeof dreSchema>;
export type IndicatorsInput = z.infer<typeof indicatorsSchema>;
export type CostStructureInput = z.infer<typeof costStructureSchema>;
export type ExplainIndicatorInput = z.infer<typeof explainIndicatorSchema>;
export type ControladoriaInput = z.infer<typeof controladoriaInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface DreStatement {
  receitaBrutaCents: number;
  deducoesCents: number;
  receitaLiquidaCents: number;
  custosCents: number;
  lucroBrutoCents: number;
  despesasOperacionaisCents: number;
  ebitdaCents: number;
  resultadoFinanceiroCents: number;
  resultadoCents: number;
  outrasCents: number;
}

export interface DreBreakdownLine {
  dreGroup: DreGroup;
  categoryId: ID | null;
  categoryName: string;
  amountCents: number;
}

export interface DreData {
  period: ISOMonth;
  dre: DreStatement;
  breakdown: DreBreakdownLine[];
  formula: string;
  regime: "competencia";
}

export interface IndicatorEntry {
  key: string;
  label: string;
  valueCents?: number | null;
  valuePercent?: number | null;
  valueDays?: number | null;
  formula: string;
  period: string;
  sources: string[];
  /** 1–2 frases em linguagem simples para o dono de PME. */
  explanation: string;
}

export interface IndicatorsData {
  period: ISOMonth;
  indicators: IndicatorEntry[];
  regime: "competencia";
}

export type CostClassification = "fixo" | "variavel" | "outros";

export interface CostStructureLine {
  categoryId: ID | null;
  categoryName: string;
  dreGroup: DreGroup;
  classification: CostClassification;
  amountCents: number;
  /** Percentual sobre o total de saídas do período (2 casas); null se total = 0. */
  pctOfTotal: number | null;
}

export interface CostStructureData {
  period: ISOMonth;
  fixed: CostStructureLine[];
  variable: CostStructureLine[];
  other: CostStructureLine[];
  totals: {
    fixedCents: number;
    variableCents: number;
    otherCents: number;
    totalOutflowsCents: number;
    fixedPct: number | null;
    variablePct: number | null;
    otherPct: number | null;
  };
  formula: string;
  regime: "competencia";
}

export interface ExplainIndicatorData {
  indicator: string;
  label: string;
  explanation: string;
  example: string;
}

export type ControladoriaData = DreData | IndicatorsData | CostStructureData | ExplainIndicatorData;

// ---------------------------------------------------------------------------
// Constantes e helpers
// ---------------------------------------------------------------------------

const REGIME_ASSUMPTION =
  "DRE gerencial apurada por regime de COMPETÊNCIA: cada título entra no período pela data de emissão (issueDate); recebíveis contam como receita e pagáveis como custos/despesas, classificados pelo dreGroup da categoria; títulos cancelados ficam de fora.";

const EBITDA_ASSUMPTION =
  "EBITDA gerencial: lucro bruto menos despesas operacionais, sem depreciação e amortização (D&A não é controlada no MVP).";

const FIXO_VARIAVEL_ASSUMPTION =
  "Simplificação da estrutura de custos: custos FIXOS = grupo despesas_operacionais; custos VARIÁVEIS = grupos custos + deducoes. Demais saídas (financeiras/outras/sem categoria) ficam em 'outros'.";

const CICLO_ASSUMPTION =
  "Ciclo financeiro calculado sem estoque (PMR - PMP); adequado para PMEs de serviços ou com estoque irrelevante.";

const DRE_GROUP_ORDER: DreGroup[] = [
  "receita_bruta",
  "deducoes",
  "custos",
  "despesas_operacionais",
  "receitas_financeiras",
  "despesas_financeiras",
  "outras",
];

const AR_OPEN_STATUSES: Receivable["status"][] = ["open", "partially_received"];
const AP_OPEN_STATUSES: Payable["status"][] = ["open", "scheduled", "partially_paid"];

/** Percentual arredondado a 2 casas (half-up) — percentuais não são dinheiro. */
function roundPct(x: number): number {
  return Math.round(x * 100) / 100;
}

async function loadCategoryMap(ctx: SkillContext): Promise<Map<ID, Category>> {
  const categories = await ctx.repos.categories.listAll(ctx.companyId);
  return new Map(categories.map((c) => [c.id, c]));
}

/**
 * Persiste um alerta apenas se não houver outro ABERTO com mesmo code+entityId
 * (dedupe para reexecuções não inflarem o painel de alertas).
 */
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

// ---------------------------------------------------------------------------
// Núcleo de cálculo (compartilhado por dre / indicators / cost_structure)
// ---------------------------------------------------------------------------

interface DreComputation {
  statement: DreStatement;
  breakdown: DreBreakdownLine[];
  pendingItems: PendingItem[];
  uncategorizedCount: number;
}

/** Resolve o grupo de DRE de um título; sem categoria (ou categoria inexistente) → "outras". */
function resolveGroup(
  categoryId: ID | undefined,
  categories: Map<ID, Category>
): { group: DreGroup; category: Category | null } {
  const category = categoryId ? (categories.get(categoryId) ?? null) : null;
  return { group: category?.dreGroup ?? "outras", category };
}

async function computeDre(ctx: SkillContext, period: ISOMonth): Promise<DreComputation> {
  const categories = await loadCategoryMap(ctx);
  const receivables = (await ctx.repos.receivables.listAll(ctx.companyId)).filter(
    (r) => r.status !== "canceled" && monthOf(r.issueDate) === period
  );
  const payables = (await ctx.repos.payables.listAll(ctx.companyId)).filter(
    (p) => p.status !== "canceled" && monthOf(p.issueDate) === period
  );

  const buckets: Record<DreGroup, number> = {
    receita_bruta: 0,
    deducoes: 0,
    custos: 0,
    despesas_operacionais: 0,
    despesas_financeiras: 0,
    receitas_financeiras: 0,
    outras: 0,
  };
  const breakdownMap = new Map<string, DreBreakdownLine>();
  const pendingItems: PendingItem[] = [];
  let uncategorizedCount = 0;

  const account = (
    entityType: "receivable" | "payable",
    id: ID,
    categoryId: ID | undefined,
    amountCents: number
  ) => {
    const { group, category } = resolveGroup(categoryId, categories);
    buckets[group] += amountCents;
    const key = `${group}|${category?.id ?? "sem_categoria"}`;
    const line = breakdownMap.get(key) ?? {
      dreGroup: group,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? "Sem categoria",
      amountCents: 0,
    };
    line.amountCents += amountCents;
    breakdownMap.set(key, line);
    if (!category) {
      uncategorizedCount += 1;
      pendingItems.push({
        code: "titulo_sem_categoria",
        description: `Título ${id} sem categoria válida; alocado ao grupo "outras" na DRE.`,
        entityType,
        entityId: id,
        suggestedAction: "Classificar o título em uma categoria com grupo de DRE adequado.",
      });
    }
  };

  for (const r of receivables) account("receivable", r.id, r.categoryId, r.amountCents);
  for (const p of payables) account("payable", p.id, p.categoryId, p.amountCents);

  const receitaLiquidaCents = buckets.receita_bruta - buckets.deducoes;
  const lucroBrutoCents = receitaLiquidaCents - buckets.custos;
  const ebitdaCents = lucroBrutoCents - buckets.despesas_operacionais;
  const resultadoFinanceiroCents = buckets.receitas_financeiras - buckets.despesas_financeiras;

  const statement: DreStatement = {
    receitaBrutaCents: buckets.receita_bruta,
    deducoesCents: buckets.deducoes,
    receitaLiquidaCents,
    custosCents: buckets.custos,
    lucroBrutoCents,
    despesasOperacionaisCents: buckets.despesas_operacionais,
    ebitdaCents,
    resultadoFinanceiroCents,
    resultadoCents: ebitdaCents + resultadoFinanceiroCents,
    outrasCents: buckets.outras,
  };

  const breakdown = [...breakdownMap.values()].sort((a, b) => {
    const ga = DRE_GROUP_ORDER.indexOf(a.dreGroup);
    const gb = DRE_GROUP_ORDER.indexOf(b.dreGroup);
    if (ga !== gb) return ga - gb;
    return a.categoryName.localeCompare(b.categoryName, "pt-BR");
  });

  return { statement, breakdown, pendingItems, uncategorizedCount };
}

interface OutflowStructure {
  fixed: CostStructureLine[];
  variable: CostStructureLine[];
  other: CostStructureLine[];
  fixedCents: number;
  variableCents: number;
  otherCents: number;
  totalOutflowsCents: number;
  uncategorizedCount: number;
}

function classifyOutflow(group: DreGroup): CostClassification {
  if (group === "despesas_operacionais") return "fixo";
  if (group === "custos" || group === "deducoes") return "variavel";
  return "outros";
}

/** Estrutura de saídas do período: só pagáveis não cancelados emitidos no mês. */
async function computeOutflowStructure(
  ctx: SkillContext,
  period: ISOMonth
): Promise<OutflowStructure> {
  const categories = await loadCategoryMap(ctx);
  const payables = (await ctx.repos.payables.listAll(ctx.companyId)).filter(
    (p) => p.status !== "canceled" && monthOf(p.issueDate) === period
  );

  const lineMap = new Map<string, CostStructureLine>();
  let uncategorizedCount = 0;
  for (const p of payables) {
    const { group, category } = resolveGroup(p.categoryId, categories);
    if (!category) uncategorizedCount += 1;
    const classification = classifyOutflow(group);
    const key = `${group}|${category?.id ?? "sem_categoria"}`;
    const line = lineMap.get(key) ?? {
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? "Sem categoria",
      dreGroup: group,
      classification,
      amountCents: 0,
      pctOfTotal: null,
    };
    line.amountCents += p.amountCents;
    lineMap.set(key, line);
  }

  const lines = [...lineMap.values()];
  const totalOutflowsCents = lines.reduce((acc, l) => acc + l.amountCents, 0);
  for (const line of lines) {
    line.pctOfTotal =
      totalOutflowsCents > 0 ? roundPct((line.amountCents / totalOutflowsCents) * 100) : null;
  }
  const byAmountDesc = (a: CostStructureLine, b: CostStructureLine) =>
    b.amountCents - a.amountCents || a.categoryName.localeCompare(b.categoryName, "pt-BR");

  const fixed = lines.filter((l) => l.classification === "fixo").sort(byAmountDesc);
  const variable = lines.filter((l) => l.classification === "variavel").sort(byAmountDesc);
  const other = lines.filter((l) => l.classification === "outros").sort(byAmountDesc);

  return {
    fixed,
    variable,
    other,
    fixedCents: fixed.reduce((acc, l) => acc + l.amountCents, 0),
    variableCents: variable.reduce((acc, l) => acc + l.amountCents, 0),
    otherCents: other.reduce((acc, l) => acc + l.amountCents, 0),
    totalOutflowsCents,
    uncategorizedCount,
  };
}

// ---------------------------------------------------------------------------
// Ação: dre
// ---------------------------------------------------------------------------

const DRE_FORMULA =
  "receitaLiquida = receitaBruta - deducoes; lucroBruto = receitaLiquida - custos; " +
  "ebitda = lucroBruto - despesasOperacionais (gerencial, sem D&A); " +
  "resultadoFinanceiro = receitasFinanceiras - despesasFinanceiras; " +
  "resultado = ebitda + resultadoFinanceiro; " +
  "cada grupo soma os títulos não cancelados emitidos no período (competência por issueDate)";

async function dre(ctx: SkillContext, input: DreInput): Promise<SkillResult<DreData>> {
  const { statement, breakdown, pendingItems, uncategorizedCount } = await computeDre(
    ctx,
    input.period
  );

  const assumptions = [REGIME_ASSUMPTION, EBITDA_ASSUMPTION];
  if (uncategorizedCount > 0) {
    assumptions.push(
      `${uncategorizedCount} título(s) sem categoria válida foram alocados ao grupo "outras".`
    );
  }

  const alerts: SkillAlert[] = [];
  if (statement.resultadoCents < 0) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "dre_resultado_negativo",
      message: `Resultado gerencial negativo em ${input.period}: ${formatBRL(statement.resultadoCents)}.`,
      entityType: "dre",
      entityId: input.period,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  return makeResult(
    SKILL,
    ctx,
    {
      period: input.period,
      dre: statement,
      breakdown,
      formula: DRE_FORMULA,
      regime: "competencia" as const,
    },
    { alerts, pendingItems, assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Ação: indicators
// ---------------------------------------------------------------------------

async function indicators(
  ctx: SkillContext,
  input: IndicatorsInput
): Promise<SkillResult<IndicatorsData>> {
  const period = input.period;
  const today = ctx.today();
  const { statement, pendingItems, uncategorizedCount } = await computeDre(ctx, period);
  const outflows = await computeOutflowStructure(ctx, period);

  const assumptions = [
    REGIME_ASSUMPTION,
    EBITDA_ASSUMPTION,
    FIXO_VARIAVEL_ASSUMPTION,
    CICLO_ASSUMPTION,
  ];
  if (uncategorizedCount > 0) {
    assumptions.push(
      `${uncategorizedCount} título(s) sem categoria válida foram alocados ao grupo "outras".`
    );
  }
  const alerts: SkillAlert[] = [];
  const entries: IndicatorEntry[] = [];

  // --- Margens sobre a DRE do período -------------------------------------
  const semReceitaLiquida = statement.receitaLiquidaCents <= 0;
  if (semReceitaLiquida) {
    assumptions.push(
      `Receita líquida não positiva em ${period}; margens percentuais não foram calculadas (divisão por zero).`
    );
  }
  entries.push({
    key: "margem_bruta",
    label: "Margem bruta",
    valuePercent: semReceitaLiquida
      ? null
      : roundPct((statement.lucroBrutoCents / statement.receitaLiquidaCents) * 100),
    formula: "margem bruta % = lucro bruto ÷ receita líquida × 100",
    period,
    sources: ["receivables", "payables", "categories"],
    explanation:
      "De cada R$ 100 vendidos (já sem impostos), quanto sobra depois de pagar o custo direto do produto ou serviço. Quanto maior, mais folga para cobrir as demais despesas.",
  });
  entries.push({
    key: "margem_operacional",
    label: "Margem operacional (EBITDA)",
    valuePercent: semReceitaLiquida
      ? null
      : roundPct((statement.ebitdaCents / statement.receitaLiquidaCents) * 100),
    formula: "margem operacional % = EBITDA gerencial ÷ receita líquida × 100",
    period,
    sources: ["receivables", "payables", "categories"],
    explanation:
      "Quanto da receita vira resultado da operação depois de custos e despesas do dia a dia. Mostra se o negócio em si dá lucro, antes de juros e efeitos financeiros.",
  });
  entries.push({
    key: "ebitda_gerencial",
    label: "EBITDA gerencial",
    valueCents: statement.ebitdaCents,
    formula: "EBITDA gerencial = lucro bruto - despesas operacionais (sem D&A)",
    period,
    sources: ["receivables", "payables", "categories"],
    explanation:
      "É o lucro gerado pela operação do negócio no mês, sem contar juros e aplicações. Se for negativo, a operação está consumindo caixa.",
  });

  // --- Ponto de equilíbrio --------------------------------------------------
  const custosFixosCents = statement.despesasOperacionaisCents;
  const custosVariaveisCents = statement.custosCents + statement.deducoesCents;
  let pontoEquilibrioCents: number | null = null;
  if (statement.receitaBrutaCents > 0) {
    const margemContribuicao =
      (statement.receitaLiquidaCents - custosVariaveisCents) / statement.receitaBrutaCents;
    if (margemContribuicao > 0) {
      pontoEquilibrioCents = Math.round(custosFixosCents / margemContribuicao);
    } else {
      assumptions.push(
        `Margem de contribuição não positiva em ${period}; ponto de equilíbrio não calculado (custos variáveis consomem toda a receita).`
      );
    }
  } else {
    assumptions.push(
      `Receita bruta zerada em ${period}; ponto de equilíbrio não calculado (sem base para margem de contribuição).`
    );
  }
  entries.push({
    key: "ponto_equilibrio",
    label: "Ponto de equilíbrio",
    valueCents: pontoEquilibrioCents,
    formula:
      "ponto de equilíbrio (R$) = custos fixos ÷ margem de contribuição; " +
      "margem de contribuição = (receita líquida - custos variáveis) ÷ receita bruta; " +
      "fixos = despesas_operacionais; variáveis = custos + deducoes",
    period,
    sources: ["receivables", "payables", "categories"],
    explanation:
      "É o faturamento mínimo do mês para não ter prejuízo: abaixo disso a empresa perde dinheiro, acima começa a lucrar.",
  });

  // --- Capital de giro (foto de hoje) --------------------------------------
  const arOpen = await ctx.repos.receivables.listByStatus(ctx.companyId, AR_OPEN_STATUSES);
  const apOpen = await ctx.repos.payables.listByStatus(ctx.companyId, AP_OPEN_STATUSES);
  const arOpenCents = arOpen.reduce((acc, r) => acc + (r.amountCents - r.receivedCents), 0);
  const apOpenCents = apOpen.reduce((acc, p) => acc + (p.amountCents - p.paidCents), 0);
  const capitalGiroCents = arOpenCents - apOpenCents;
  entries.push({
    key: "capital_giro",
    label: "Capital de giro (AR - AP em aberto)",
    valueCents: capitalGiroCents,
    formula:
      "capital de giro = saldo a receber em aberto (amount - received) - saldo a pagar em aberto (amount - paid), posição de hoje",
    period: today,
    sources: ["receivables", "payables", "receipts", "payments"],
    explanation:
      "Compara o que você ainda tem a receber com o que ainda tem a pagar hoje. Se for negativo, as contas a pagar superam as contas a receber e pode faltar caixa.",
  });
  if (capitalGiroCents < 0) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "capital_giro_negativo",
      message: `Capital de giro negativo em ${today}: ${formatBRL(capitalGiroCents)} (a pagar em aberto supera a receber).`,
      entityType: "indicator",
      entityId: `capital_giro:${today}`,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  // --- PMR / PMP / ciclo financeiro (janela de 90 dias até hoje) ------------
  const start90: ISODate = addDays(today, -89); // 90 dias corridos, inclusive hoje
  const window90 = `${start90} a ${today}`;
  const allReceivables = await ctx.repos.receivables.listAll(ctx.companyId);
  const allPayables = await ctx.repos.payables.listAll(ctx.companyId);
  const receita90Cents = allReceivables
    .filter((r) => r.status !== "canceled" && r.issueDate >= start90 && r.issueDate <= today)
    .reduce((acc, r) => acc + r.amountCents, 0);
  const compras90Cents = allPayables
    .filter((p) => p.status !== "canceled" && p.issueDate >= start90 && p.issueDate <= today)
    .reduce((acc, p) => acc + p.amountCents, 0);

  const pmrDays = receita90Cents > 0 ? Math.round((arOpenCents * 90) / receita90Cents) : null;
  if (pmrDays === null) {
    assumptions.push("Sem receita emitida nos últimos 90 dias; PMR não calculado.");
  }
  const pmpDays = compras90Cents > 0 ? Math.round((apOpenCents * 90) / compras90Cents) : null;
  if (pmpDays === null) {
    assumptions.push("Sem compras emitidas nos últimos 90 dias; PMP não calculado.");
  }
  const cicloDays = pmrDays !== null && pmpDays !== null ? pmrDays - pmpDays : null;

  entries.push({
    key: "pmr",
    label: "Prazo médio de recebimento (PMR)",
    valueDays: pmrDays,
    formula: "PMR (dias) = saldo a receber em aberto ÷ receita bruta dos últimos 90 dias × 90",
    period: window90,
    sources: ["receivables", "receipts"],
    explanation:
      "Quantos dias, em média, o dinheiro das vendas demora para entrar no caixa. Quanto menor, mais rápido você recebe dos clientes.",
  });
  entries.push({
    key: "pmp",
    label: "Prazo médio de pagamento (PMP)",
    valueDays: pmpDays,
    formula: "PMP (dias) = saldo a pagar em aberto ÷ compras dos últimos 90 dias × 90",
    period: window90,
    sources: ["payables", "payments"],
    explanation:
      "Quantos dias, em média, você leva para pagar os fornecedores. Prazos maiores ajudam o caixa, desde que negociados sem multa.",
  });
  entries.push({
    key: "ciclo_financeiro",
    label: "Ciclo financeiro",
    valueDays: cicloDays,
    formula: "ciclo financeiro (dias) = PMR - PMP (sem estoque)",
    period: window90,
    sources: ["receivables", "payables", "receipts", "payments"],
    explanation:
      "Quantos dias a empresa financia a operação do próprio bolso: recebe dos clientes depois (ou antes) de pagar os fornecedores. Negativo é bom — você recebe antes de pagar.",
  });

  // --- Estrutura de custos sobre o total de saídas do período ---------------
  const semSaidas = outflows.totalOutflowsCents <= 0;
  if (semSaidas) {
    assumptions.push(
      `Sem saídas (pagáveis) emitidas em ${period}; percentuais de custos fixos/variáveis não calculados.`
    );
  }
  entries.push({
    key: "custos_fixos_pct",
    label: "Custos fixos (% das saídas)",
    valuePercent: semSaidas
      ? null
      : roundPct((outflows.fixedCents / outflows.totalOutflowsCents) * 100),
    formula:
      "custos fixos % = despesas_operacionais ÷ total de saídas (pagáveis) do período × 100",
    period,
    sources: ["payables", "categories"],
    explanation:
      "Parcela dos gastos do mês que existe independentemente de vender (aluguel, salários, contador). Quanto maior, mais receita mínima você precisa para se sustentar.",
  });
  entries.push({
    key: "custos_variaveis_pct",
    label: "Custos variáveis (% das saídas)",
    valuePercent: semSaidas
      ? null
      : roundPct((outflows.variableCents / outflows.totalOutflowsCents) * 100),
    formula:
      "custos variáveis % = (custos + deducoes) ÷ total de saídas (pagáveis) do período × 100",
    period,
    sources: ["payables", "categories"],
    explanation:
      "Parcela dos gastos que cresce junto com as vendas (mercadoria, insumos, impostos sobre venda). Sobem quando você vende mais — o importante é a margem que sobra.",
  });

  return makeResult(
    SKILL,
    ctx,
    { period, indicators: entries, regime: "competencia" as const },
    { alerts, pendingItems, assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Ação: cost_structure
// ---------------------------------------------------------------------------

async function costStructure(
  ctx: SkillContext,
  input: CostStructureInput
): Promise<SkillResult<CostStructureData>> {
  const s = await computeOutflowStructure(ctx, input.period);
  const total = s.totalOutflowsCents;

  const assumptions = [REGIME_ASSUMPTION, FIXO_VARIAVEL_ASSUMPTION];
  const pendingItems: PendingItem[] = [];
  if (s.uncategorizedCount > 0) {
    assumptions.push(
      `${s.uncategorizedCount} pagável(is) sem categoria válida classificados em "outros".`
    );
    pendingItems.push({
      code: "saidas_sem_categoria",
      description: `${s.uncategorizedCount} pagável(is) do período ${input.period} sem categoria válida.`,
      suggestedAction: "Classificar os títulos em categorias com grupo de DRE adequado.",
    });
  }

  return makeResult(
    SKILL,
    ctx,
    {
      period: input.period,
      fixed: s.fixed,
      variable: s.variable,
      other: s.other,
      totals: {
        fixedCents: s.fixedCents,
        variableCents: s.variableCents,
        otherCents: s.otherCents,
        totalOutflowsCents: total,
        fixedPct: total > 0 ? roundPct((s.fixedCents / total) * 100) : null,
        variablePct: total > 0 ? roundPct((s.variableCents / total) * 100) : null,
        otherPct: total > 0 ? roundPct((s.otherCents / total) * 100) : null,
      },
      formula:
        "total de saídas = Σ pagáveis não cancelados emitidos no período; " +
        "fixos = grupo despesas_operacionais; variáveis = grupos custos + deducoes; " +
        "percentual de cada categoria = valor ÷ total de saídas × 100",
      regime: "competencia" as const,
    },
    { assumptions, pendingItems, confidence: 1.0, dataSources: ["payables", "categories"] }
  );
}

// ---------------------------------------------------------------------------
// Ação: explain_indicator — dicionário estático (determinístico, sem IA)
// ---------------------------------------------------------------------------

const GLOSSARY: Record<string, { label: string; explanation: string; example: string }> = {
  margem_bruta: {
    label: "Margem bruta",
    explanation:
      "Mostra quanto sobra de cada venda depois de pagar o custo direto do produto ou serviço, já descontados os impostos sobre a venda. É a primeira medida de saúde do seu preço: se a margem bruta é baixa, nem cortando despesas o negócio fecha a conta.",
    example:
      "Exemplo: receita líquida de R$ 90.000,00 e custo dos produtos de R$ 30.000,00 → lucro bruto de R$ 60.000,00 e margem bruta de 66,67%.",
  },
  margem_operacional: {
    label: "Margem operacional",
    explanation:
      "Indica quanto da receita vira resultado depois de custos e também das despesas do dia a dia (aluguel, salários, contador). É o retrato de quanto a operação realmente rende antes de juros e aplicações.",
    example:
      "Exemplo: receita líquida de R$ 90.000,00 e EBITDA de R$ 40.000,00 → margem operacional de 44,44%.",
  },
  ebitda: {
    label: "EBITDA gerencial",
    explanation:
      "É o lucro que a operação do negócio gera, sem contar juros, aplicações, depreciação e amortização. Serve para responder: 'a atividade em si dá dinheiro?' — independentemente de dívidas e investimentos.",
    example:
      "Exemplo: lucro bruto de R$ 60.000,00 menos despesas operacionais de R$ 20.000,00 → EBITDA de R$ 40.000,00.",
  },
  margem_contribuicao: {
    label: "Margem de contribuição",
    explanation:
      "É a fatia de cada venda que sobra depois de pagar apenas os custos que variam com a venda (mercadoria, insumos, impostos sobre a venda). Essa sobra é o que 'contribui' para pagar os custos fixos e formar o lucro.",
    example:
      "Exemplo: a cada R$ 100,00 vendidos, R$ 50,00 vão para custos variáveis → margem de contribuição de 50%.",
  },
  ponto_equilibrio: {
    label: "Ponto de equilíbrio",
    explanation:
      "É o faturamento mínimo do mês para a empresa não ter prejuízo: o valor de vendas em que a margem de contribuição paga exatamente os custos fixos. Vender abaixo disso significa perder dinheiro no mês.",
    example:
      "Exemplo: custos fixos de R$ 20.000,00 e margem de contribuição de 50% → é preciso faturar R$ 40.000,00 no mês para empatar.",
  },
  capital_giro: {
    label: "Capital de giro",
    explanation:
      "Compara o que você ainda tem a receber de clientes com o que ainda tem a pagar a fornecedores. Se o valor é negativo, as contas a pagar superam as contas a receber e pode faltar dinheiro para tocar o dia a dia.",
    example:
      "Exemplo: R$ 80.000,00 a receber e R$ 50.000,00 a pagar → capital de giro de R$ 30.000,00.",
  },
  ciclo_financeiro: {
    label: "Ciclo financeiro",
    explanation:
      "Mede quantos dias a empresa banca a operação do próprio bolso: a diferença entre o prazo em que você recebe dos clientes e o prazo em que paga os fornecedores. Ciclo negativo é ótimo — você recebe antes de precisar pagar.",
    example:
      "Exemplo: recebe em média em 45 dias e paga em média em 30 dias → ciclo financeiro de 15 dias para financiar com caixa próprio.",
  },
  pmr: {
    label: "Prazo médio de recebimento (PMR)",
    explanation:
      "Quantos dias, em média, o dinheiro das suas vendas demora para entrar no caixa. Quanto menor, melhor: reduzir o PMR (cobrando antes ou oferecendo desconto à vista) alivia o caixa sem vender mais.",
    example:
      "Exemplo: R$ 60.000,00 a receber em aberto e R$ 120.000,00 vendidos nos últimos 90 dias → PMR de 45 dias.",
  },
  dso: {
    label: "DSO (Days Sales Outstanding)",
    explanation:
      "É o nome em inglês do prazo médio de recebimento (PMR): quantos dias, em média, as vendas demoram para virar dinheiro no caixa. Quanto menor, mais rápido você recebe dos clientes.",
    example:
      "Exemplo: R$ 60.000,00 a receber em aberto e R$ 120.000,00 vendidos nos últimos 90 dias → DSO de 45 dias.",
  },
  pmp: {
    label: "Prazo médio de pagamento (PMP)",
    explanation:
      "Quantos dias, em média, você leva para pagar seus fornecedores. Prazos maiores dão fôlego ao caixa — desde que negociados, sem atraso e sem multa.",
    example:
      "Exemplo: R$ 30.000,00 a pagar em aberto e R$ 90.000,00 comprados nos últimos 90 dias → PMP de 30 dias.",
  },
  dpo: {
    label: "DPO (Days Payable Outstanding)",
    explanation:
      "É o nome em inglês do prazo médio de pagamento (PMP): quantos dias, em média, a empresa demora para pagar os fornecedores. Prazos maiores ajudam o caixa quando negociados sem encargos.",
    example:
      "Exemplo: R$ 30.000,00 a pagar em aberto e R$ 90.000,00 comprados nos últimos 90 dias → DPO de 30 dias.",
  },
  custos_fixos: {
    label: "Custos fixos",
    explanation:
      "Gastos que existem todo mês, venda ou não venda: aluguel, salários, contador, sistemas. Quanto maiores os fixos, maior o faturamento mínimo necessário para não ter prejuízo.",
    example:
      "Exemplo: aluguel de R$ 5.000,00 + folha de R$ 12.000,00 + contador de R$ 1.000,00 → R$ 18.000,00 de custos fixos por mês.",
  },
  custos_variaveis: {
    label: "Custos variáveis",
    explanation:
      "Gastos que crescem junto com as vendas: mercadoria, insumos, comissões e impostos sobre a venda. Eles não são um problema em si — o que importa é a margem que sobra depois deles.",
    example:
      "Exemplo: vendendo R$ 50.000,00 com 40% de custos variáveis, você gasta R$ 20.000,00; vendendo R$ 100.000,00, gasta R$ 40.000,00.",
  },
};

// EBITDA gerencial compartilha o verbete de EBITDA (mesmo conceito no MVP).
GLOSSARY.ebitda_gerencial = GLOSSARY.ebitda;

async function explainIndicator(
  ctx: SkillContext,
  input: ExplainIndicatorInput
): Promise<SkillResult<ExplainIndicatorData>> {
  const key = input.indicator.trim().toLowerCase();
  const entry = GLOSSARY[key];
  if (!entry) throw new NotFoundError("Indicador", input.indicator);

  return makeResult(
    SKILL,
    ctx,
    { indicator: key, label: entry.label, explanation: entry.explanation, example: entry.example },
    {
      confidence: 1.0,
      assumptions: ["Explicação de dicionário estático em pt-BR; nenhum dado da empresa foi usado."],
      dataSources: ["glossario_estatico"],
    }
  );
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const controladoriaSkill: SkillDefinition<ControladoriaInput, ControladoriaData> = {
  name: SKILL,
  responsibility:
    "DRE gerencial por competência; margens, EBITDA gerencial, ponto de equilíbrio, capital de giro e ciclo financeiro; estrutura de custos fixos vs. variáveis; explicação de indicadores em linguagem simples.",
  objective:
    "Dar ao dono da PME uma leitura determinística e explicável da saúde econômica do negócio, com fórmula, período e fontes explícitos em cada número.",
  inputSchema: controladoriaInputSchema,
  consumes: [],
  publishes: [],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "dre":
        return dre(ctx, input);
      case "indicators":
        return indicators(ctx, input);
      case "cost_structure":
        return costStructure(ctx, input);
      case "explain_indicator":
        return explainIndicator(ctx, input);
    }
  },
};
