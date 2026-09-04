/**
 * Skill INTEGRAÇÃO CONTÁBIL E FISCAL — classifica liquidações (pagamentos
 * executados e recebimentos) em lançamentos de partida dobrada para exportação
 * à contabilidade, valida cadastros e produz resumo fiscal INFORMATIVO.
 *
 * Restrições centrais:
 * - Esta skill NÃO substitui o contador: toda classificação, lote exportado e
 *   resumo fiscal exigem validação de um contador responsável (assumption em
 *   toda resposta).
 * - Regras tributárias vêm SEMPRE de ctx.config.taxRules (dados) — nenhuma
 *   alíquota ou regime é fixado em código; nenhum imposto é calculado aqui.
 *
 * Mapeamento determinístico categoria (dreGroup) → contas de partida dobrada:
 * - receita (receita_bruta/receitas_financeiras) → crédito "3.1", débito "1.1"
 * - deducoes             → débito "2.2", crédito "1.1"
 * - custos               → débito "4.1", crédito "1.1"
 * - despesas_operacionais→ débito "4.2", crédito "1.1"
 * - despesas_financeiras → débito "4.3", crédito "1.1"
 * - sem categoria (ou dreGroup não mapeado em despesa) → débito "4.2" +
 *   pending_item para classificação manual.
 */

import { z } from "zod";
import { persistAlert } from "@/core/alerts";
import {
  endOfMonth,
  monthOf,
  startOfMonth,
  todayInTz,
  type ISODate,
  type ISOMonth,
} from "@/core/dates";
import type {
  AccountingEntry,
  Category,
  DreGroup,
  Payment,
  Receipt,
} from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import { formatBRL, receiptIsActive } from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";
import {
  EXPORT_LAYOUTS,
  EXPORT_LAYOUT_IDS,
  layoutFilename,
  renderLayoutLines,
  type ExportLayoutId,
} from "./layouts";

const SKILL = "integracao_contabil_fiscal" as const;
const DATA_SOURCES = [
  "payments",
  "receipts",
  "payables",
  "receivables",
  "categories",
  "chart_accounts",
];

/** Presente em TODA resposta: a skill prepara dados, o contador valida. */
const ACCOUNTANT_ASSUMPTION =
  "Esta skill não substitui o contador: classificações, lotes e resumos são preparatórios e exigem validação de um contador responsável.";

// Contas do plano de contas seed usadas pelo mapeamento determinístico.
const ACCOUNT_CASH = "1.1";
const ACCOUNT_REVENUE = "3.1";
const ACCOUNT_DEFAULT_EXPENSE = "4.2";

/** Débito do pagamento por grupo de DRE da categoria do título. */
const PAYMENT_DEBIT_BY_DRE: Partial<Record<DreGroup, string>> = {
  deducoes: "2.2",
  custos: "4.1",
  despesas_operacionais: "4.2",
  despesas_financeiras: "4.3",
};

const REVENUE_DRE_GROUPS: DreGroup[] = ["receita_bruta", "receitas_financeiras"];

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "período inválido (esperado YYYY-MM)");

// A validação cruzada (period XOR sourceType+sourceId) fica no union abaixo:
// z.discriminatedUnion do zod v3 exige ZodObject puro como opção.
const prepareEntriesSchema = z.object({
  action: z.literal("prepare_entries"),
  period: periodSchema.optional(),
  sourceType: z.enum(["payment", "receipt"]).optional(),
  sourceId: z.string().min(1).optional(),
});

const exportBatchSchema = z.object({
  action: z.literal("export_batch"),
  period: periodSchema,
  /** Compatibilidade: o conteúdo é sempre texto delimitado; o layout decide o formato. */
  format: z.literal("csv").optional(),
  /** Layout de exportação (default: "padrao"); demais são layouts de REFERÊNCIA. */
  layout: z.enum(EXPORT_LAYOUT_IDS).optional(),
});

// Estorno CONTÁBIL de uma origem (ex.: pagamento estornado): não apaga o
// lançamento original — cria o lançamento INVERSO, como manda a prática
// contábil e como o resto do app faz (nada auditado é apagado).
const reverseEntriesSchema = z.object({
  action: z.literal("reverse_entries"),
  sourceType: z.enum(["payment", "receipt"]),
  sourceId: z.string().min(1),
  reason: z.string().min(1),
});

// Realinha os lançamentos de uma origem depois que a DATA dela foi corrigida
// (ex.: a data de pagamento ajustada em Conciliados). O lançamento já criado
// nunca é revisitado por prepare_entries — que é idempotente por origem —,
// então sem esta ação a contabilidade ficaria com a data antiga.
const restateEntriesSchema = z.object({
  action: z.literal("restate_entries"),
  sourceType: z.enum(["payment", "receipt"]),
  sourceId: z.string().min(1),
  reason: z.string().min(1),
});

const checkMasterDataSchema = z.object({
  action: z.literal("check_master_data"),
});

const taxSummarySchema = z.object({
  action: z.literal("tax_summary"),
  period: periodSchema,
});

export const contabilInputSchema = z
  .discriminatedUnion("action", [
    prepareEntriesSchema,
    reverseEntriesSchema,
    restateEntriesSchema,
    exportBatchSchema,
    checkMasterDataSchema,
    taxSummarySchema,
  ])
  .superRefine((v, issueCtx) => {
    if (v.action !== "prepare_entries") return;
    const hasSource = v.sourceType !== undefined || v.sourceId !== undefined;
    if (hasSource && (v.sourceType === undefined || v.sourceId === undefined)) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceType e sourceId devem ser informados juntos",
      });
    }
    if (v.period === undefined && !hasSource) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "informe period OU sourceType+sourceId",
      });
    }
    if (v.period !== undefined && hasSource) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "informe apenas um modo: period OU sourceType+sourceId",
      });
    }
  });

export type PrepareEntriesInput = z.infer<typeof prepareEntriesSchema>;
export type ReverseEntriesInput = z.infer<typeof reverseEntriesSchema>;
export type RestateEntriesInput = z.infer<typeof restateEntriesSchema>;
export type ExportBatchInput = z.infer<typeof exportBatchSchema>;
export type CheckMasterDataInput = z.infer<typeof checkMasterDataSchema>;
export type TaxSummaryInput = z.infer<typeof taxSummarySchema>;
export type ContabilInput = z.infer<typeof contabilInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface SkippedEntryRef {
  sourceType: "payment" | "receipt";
  sourceId: string;
  existingEntryId: string;
}

export interface PrepareEntriesData {
  entries: AccountingEntry[];
  skipped: SkippedEntryRef[];
  period?: ISOMonth;
  formula: string;
}

export interface ExportBatchData {
  batchId?: string;
  /** Conteúdo do arquivo no layout escolhido (nome histórico mantido por compatibilidade). */
  csv: string;
  count: number;
  period: ISOMonth;
  layout: { id: ExportLayoutId; name: string; fileExtension: string };
  filename: string;
  formula: string;
}

export interface MasterDataIssue {
  type: string;
  entityType: string;
  entityId: string;
  description: string;
  suggestedAction: string;
}

export interface CheckMasterDataData {
  issues: MasterDataIssue[];
  count: number;
}

export interface TaxSummaryData {
  period: { month: ISOMonth; start: ISODate; end: ISODate };
  regime: string;
  /** Receita recebida no período (regime de caixa) — base informativa, sem imposto calculado. */
  taxableRevenueCashCents: number;
  /** Receita faturada no período (regime de competência) — base informativa. */
  taxableRevenueAccrualCents: number;
  receiptsCount: number;
  receivablesCount: number;
  formula: string;
  taxRules: Record<string, unknown>;
  observacao: string;
}

export interface ReverseEntriesData {
  /** Lançamentos inversos criados nesta chamada. */
  reversals: AccountingEntry[];
  /** true quando algum lançamento original já havia sido exportado ao contador. */
  originalExported: boolean;
}

export interface RestateEntriesData {
  /** Lançamentos que tiveram a data corrigida no próprio registro. */
  corrected: AccountingEntry[];
  /** Pares estorno+relançamento, para lançamentos já exportados. */
  restated: AccountingEntry[];
}

export type ContabilData =
  | PrepareEntriesData
  | ReverseEntriesData
  | RestateEntriesData
  | ExportBatchData
  | CheckMasterDataData
  | TaxSummaryData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persiste alerta apenas se não houver outro ABERTO com mesmo code+entityId. */
async function persistAlertDeduped(ctx: SkillContext, alert: SkillAlert): Promise<void> {
  await persistAlert(ctx, alert, SKILL);
}

/** Data de negócio (fuso da empresa) de um carimbo ISO-8601 UTC. */
function businessDateOf(ctx: SkillContext, isoTimestamp: string): ISODate {
  return todayInTz(new Date(isoTimestamp), ctx.config.timezone);
}

interface EntryPlan {
  sourceType: "payment" | "receipt";
  sourceId: string;
  entryDate: ISODate;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
  memo: string;
  /** true quando a conta de despesa foi atribuída por falta de categoria mapeável. */
  unclassified: boolean;
  /** Título de origem (para pending_item de classificação). */
  titleEntityType: "payable" | "receivable";
  titleEntityId: string;
}

async function planForPayment(ctx: SkillContext, payment: Payment): Promise<EntryPlan> {
  if (payment.status !== "executed" || !payment.executedAt) {
    throw new ValidationError(
      `Pagamento ${payment.id} não está executado (status: ${payment.status}); apenas pagamentos executados geram lançamento contábil.`
    );
  }
  const payable = await ctx.repos.payables.getById(ctx.companyId, payment.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", payment.payableId);
  const supplier = await ctx.repos.suppliers.getById(ctx.companyId, payable.supplierId);
  const category: Category | null = payable.categoryId
    ? await ctx.repos.categories.getById(ctx.companyId, payable.categoryId)
    : null;
  const mappedDebit = category ? PAYMENT_DEBIT_BY_DRE[category.dreGroup] : undefined;
  return {
    sourceType: "payment",
    sourceId: payment.id,
    entryDate: businessDateOf(ctx, payment.executedAt),
    debitAccount: mappedDebit ?? ACCOUNT_DEFAULT_EXPENSE,
    creditAccount: ACCOUNT_CASH,
    amountCents: payment.amountCents,
    memo: `Pagamento a ${supplier?.name ?? payable.supplierId} — ${payable.description}`,
    unclassified: mappedDebit === undefined,
    titleEntityType: "payable",
    titleEntityId: payable.id,
  };
}

async function planForReceipt(ctx: SkillContext, receipt: Receipt): Promise<EntryPlan> {
  const receivable = await ctx.repos.receivables.getById(ctx.companyId, receipt.receivableId);
  if (!receivable) throw new NotFoundError("Título a receber", receipt.receivableId);
  const customer = await ctx.repos.customers.getById(ctx.companyId, receivable.customerId);
  const category: Category | null = receivable.categoryId
    ? await ctx.repos.categories.getById(ctx.companyId, receivable.categoryId)
    : null;
  const isRevenueCategory = category !== null && REVENUE_DRE_GROUPS.includes(category.dreGroup);
  return {
    sourceType: "receipt",
    sourceId: receipt.id,
    entryDate: receipt.receivedDate,
    debitAccount: ACCOUNT_CASH,
    // Única conta de receita do plano seed é 3.1; categoria de receita mapeia para ela.
    creditAccount: ACCOUNT_REVENUE,
    amountCents: receipt.amountCents,
    memo: `Recebimento de ${customer?.name ?? receivable.customerId} — ${receivable.description}`,
    unclassified: !isRevenueCategory,
    titleEntityType: "receivable",
    titleEntityId: receivable.id,
  };
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function prepareEntries(
  ctx: SkillContext,
  input: PrepareEntriesInput
): Promise<SkillResult<PrepareEntriesData>> {
  const assumptions: string[] = [ACCOUNTANT_ASSUMPTION];
  const alerts: SkillAlert[] = [];
  const pendingItems: PendingItem[] = [];

  // Monta os planos de lançamento conforme o modo de chamada.
  const plans: EntryPlan[] = [];
  if (input.sourceType !== undefined && input.sourceId !== undefined) {
    if (input.sourceType === "payment") {
      const payment = await ctx.repos.payments.getById(ctx.companyId, input.sourceId);
      if (!payment) throw new NotFoundError("Pagamento", input.sourceId);
      plans.push(await planForPayment(ctx, payment));
    } else {
      const receipt = await ctx.repos.receipts.getById(ctx.companyId, input.sourceId);
      if (!receipt) throw new NotFoundError("Recebimento", input.sourceId);
      plans.push(await planForReceipt(ctx, receipt));
    }
  } else {
    const period = input.period as ISOMonth;
    const executedPayments = (
      await ctx.repos.payments.listByStatus(ctx.companyId, ["executed"])
    ).filter((p) => p.executedAt && monthOf(businessDateOf(ctx, p.executedAt)) === period);
    for (const payment of executedPayments) {
      plans.push(await planForPayment(ctx, payment));
    }
    const receipts = (
      await ctx.repos.receipts.listByDateRange(
        ctx.companyId,
        startOfMonth(period),
        endOfMonth(period)
      )
    ).filter(receiptIsActive);
    for (const receipt of receipts) {
      plans.push(await planForReceipt(ctx, receipt));
    }
  }

  // Idempotência por origem: (sourceType, sourceId) já lançado não duplica.
  const existingEntries = await ctx.repos.accountingEntries.listAll(ctx.companyId);
  const existingBySource = new Map<string, AccountingEntry>(
    existingEntries.map((e) => [`${e.sourceType}:${e.sourceId}`, e])
  );

  const entries: AccountingEntry[] = [];
  const skipped: SkippedEntryRef[] = [];
  const nowIso = ctx.clock.now().toISOString();

  for (const plan of plans) {
    const existing = existingBySource.get(`${plan.sourceType}:${plan.sourceId}`);
    if (existing) {
      skipped.push({
        sourceType: plan.sourceType,
        sourceId: plan.sourceId,
        existingEntryId: existing.id,
      });
      continue;
    }
    const entry: AccountingEntry = {
      id: ctx.ids.next("ae"),
      companyId: ctx.companyId,
      entryDate: plan.entryDate,
      debitAccount: plan.debitAccount,
      creditAccount: plan.creditAccount,
      amountCents: plan.amountCents,
      memo: plan.memo,
      sourceType: plan.sourceType,
      sourceId: plan.sourceId,
      exported: false,
      createdAt: nowIso,
    };
    await ctx.repos.accountingEntries.create(entry);
    existingBySource.set(`${plan.sourceType}:${plan.sourceId}`, entry);
    entries.push(entry);

    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "accounting.entry_prepared",
      entityType: "accounting_entry",
      entityId: entry.id,
      after: entry,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "accounting.entry_prepared",
      payload: {
        entryId: entry.id,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        debitAccount: entry.debitAccount,
        creditAccount: entry.creditAccount,
        amountCents: entry.amountCents,
      },
      source: SKILL,
      correlationId: ctx.correlationId,
    });

    if (plan.unclassified) {
      pendingItems.push({
        code: "lancamento_sem_categoria",
        description: `Lançamento ${entry.id} usou a conta padrão ${plan.sourceType === "payment" ? entry.debitAccount : entry.creditAccount} por falta de categoria classificável no título de origem.`,
        entityType: plan.titleEntityType,
        entityId: plan.titleEntityId,
        suggestedAction:
          "Classificar o título em uma categoria com grupo de DRE válido e revisar a conta contábil com o contador.",
      });
    }
  }

  // Contas usadas que não existem no plano de contas da empresa → alerta.
  const chart = await ctx.repos.chartAccounts.listAll(ctx.companyId);
  const validCodes = new Set(chart.filter((c) => c.active).map((c) => c.code));
  const usedCodes = new Set(entries.flatMap((e) => [e.debitAccount, e.creditAccount]));
  for (const code of [...usedCodes].sort()) {
    if (!validCodes.has(code)) {
      const alert: SkillAlert = {
        severity: "warning",
        code: "conta_inexistente",
        message: `Conta contábil "${code}" usada em lançamento não existe (ou está inativa) no plano de contas da empresa.`,
        entityType: "chart_account",
        entityId: code,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
    }
  }

  if (skipped.length > 0) {
    assumptions.push(
      `${skipped.length} origem(ns) já possuía(m) lançamento contábil; nada foi duplicado (idempotência por sourceType+sourceId).`
    );
  }
  if (entries.length === 0 && skipped.length === 0) {
    assumptions.push("Nenhuma liquidação encontrada para o filtro informado; nada foi lançado.");
  }

  return makeResult(
    SKILL,
    ctx,
    {
      entries,
      skipped,
      period: input.period,
      formula:
        "pagamento executado → débito conta da categoria (deducoes→2.2, custos→4.1, despesas_operacionais→4.2, despesas_financeiras→4.3; sem categoria→4.2), crédito 1.1; recebimento → débito 1.1, crédito 3.1; valor = amountCents da liquidação; data = data de negócio da liquidação no fuso da empresa",
    },
    { alerts, pendingItems, assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

/**
 * ESTORNO CONTÁBIL de uma origem. Para cada lançamento daquela origem, cria o
 * lançamento INVERSO (débito e crédito trocados, mesmo valor). O original é
 * preservado: contabilidade não se apaga, se estorna — e é o mesmo princípio do
 * resto do app, onde nada auditado é excluído fisicamente.
 *
 * `sourceType` do inverso é "adjustment" (ajuste), valor já previsto no modelo,
 * para o inverso não ser confundido com o lançamento do próprio pagamento nem
 * ser recolhido de novo por `prepare_entries` (que é idempotente por origem).
 *
 * Se o original já foi EXPORTADO ao contador, o estorno é registrado do mesmo
 * jeito e vira pendência: quem recebeu o arquivo precisa ser avisado.
 */
async function reverseEntries(
  ctx: SkillContext,
  input: ReverseEntriesInput
): Promise<SkillResult<ReverseEntriesData>> {
  // Permissão fica no fluxo (requiredPermission), como no export_batch desta
  // mesma skill — o estorno contábil é consequência do estorno do pagamento,
  // não uma autorização separada.
  const chave = `${input.sourceType}:${input.sourceId}`;
  const originais = (await ctx.repos.accountingEntries.listAll(ctx.companyId)).filter(
    (e) => `${e.sourceType}:${e.sourceId}` === chave
  );

  if (originais.length === 0) {
    return makeResult(
      SKILL,
      ctx,
      { reversals: [], originalExported: false },
      {
        assumptions: [
          `Nenhum lançamento contábil encontrado para ${chave}; nada a estornar.`,
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }

  // Idempotência: um estorno já registrado para esta origem não é repetido.
  // O inverso carrega sourceId = "rev:<origem>", chave natural da reversão.
  const revSourceId = `rev:${input.sourceId}`;
  const jaEstornados = new Set(
    (await ctx.repos.accountingEntries.listAll(ctx.companyId))
      .filter((e) => e.sourceType === "adjustment" && e.sourceId === revSourceId)
      .map((e) => e.memo)
  );

  const nowIso = ctx.clock.now().toISOString();
  const reversals: AccountingEntry[] = [];
  const pendingItems: PendingItem[] = [];
  let originalExported = false;

  for (const original of originais) {
    if (original.exported) originalExported = true;
    const memo = `Estorno de: ${original.memo} (${input.reason})`;
    if (jaEstornados.has(memo)) continue;

    const inverso: AccountingEntry = {
      id: ctx.ids.next("ae"),
      companyId: ctx.companyId,
      // Data do estorno = hoje (fato novo), não a data do lançamento original:
      // reabrir competência fechada é decisão do contador, não do sistema.
      entryDate: ctx.today(),
      debitAccount: original.creditAccount,
      creditAccount: original.debitAccount,
      amountCents: original.amountCents,
      memo,
      sourceType: "adjustment",
      sourceId: revSourceId,
      exported: false,
      createdAt: nowIso,
    };
    await ctx.repos.accountingEntries.create(inverso);
    reversals.push(inverso);

    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "accounting.entries_reversed",
      entityType: "accounting_entry",
      entityId: inverso.id,
      before: original,
      after: inverso,
      correlationId: ctx.correlationId,
    });

    if (original.exported) {
      pendingItems.push({
        code: "estorno_de_lancamento_exportado",
        description: `O lançamento ${original.id} (${formatBRL(original.amountCents)}) já havia sido exportado ao contador; o estorno entra em lote posterior.`,
        entityType: "accounting_entry",
        entityId: original.id,
        suggestedAction:
          "Avisar o contador de que o lançamento foi estornado e enviar o próximo lote com o inverso.",
      });
    }
  }

  return makeResult(
    SKILL,
    ctx,
    { reversals, originalExported },
    {
      assumptions: [
        reversals.length === 0
          ? `Estorno de ${chave} já havia sido registrado; nada foi duplicado.`
          : `${reversals.length} lançamento(s) inverso(s) criado(s) para ${chave} (débito e crédito trocados). O lançamento original é preservado — contabilidade se estorna, não se apaga.`,
        "A data do estorno é a de hoje, não a do lançamento original: reabrir competência fechada é decisão do contador.",
      ],
      pendingItems,
      dataSources: DATA_SOURCES,
    }
  );
}

/**
 * REALINHA os lançamentos de uma origem cuja data foi corrigida (hoje: a data
 * de pagamento ajustada no card Conciliados). Sem isto a contabilidade fica com
 * a data antiga para sempre — `prepare_entries` é idempotente por origem e não
 * revisita lançamento existente.
 *
 * O tratamento depende de o lançamento já ter saído da empresa:
 *  - NÃO exportado: corrige o `entryDate` no próprio registro. Ninguém viu esse
 *    lançamento ainda; estornar e relançar só encheria o razão de linhas.
 *  - JÁ exportado: estorna (lançamento inverso) e relança com a data certa —
 *    o contador recebeu o arquivo, e o que ele tem em mãos não se reescreve.
 *    Vira pendência, para alguém avisá-lo.
 */
async function restateEntries(
  ctx: SkillContext,
  input: RestateEntriesInput
): Promise<SkillResult<RestateEntriesData>> {
  const chave = `${input.sourceType}:${input.sourceId}`;

  // A data nova vem da própria origem, já corrigida por quem chamou.
  let novaData: ISODate;
  if (input.sourceType === "payment") {
    const payment = await ctx.repos.payments.getById(ctx.companyId, input.sourceId);
    if (!payment) throw new NotFoundError("Pagamento", input.sourceId);
    if (!payment.executedAt) {
      throw new ValidationError(
        `Pagamento ${payment.id} não tem data de execução; não há o que realinhar.`
      );
    }
    novaData = businessDateOf(ctx, payment.executedAt);
  } else {
    const receipt = await ctx.repos.receipts.getById(ctx.companyId, input.sourceId);
    if (!receipt) throw new NotFoundError("Recebimento", input.sourceId);
    novaData = receipt.receivedDate;
  }

  const originais = (await ctx.repos.accountingEntries.listAll(ctx.companyId)).filter(
    (e) => `${e.sourceType}:${e.sourceId}` === chave && e.entryDate !== novaData
  );

  if (originais.length === 0) {
    return makeResult(
      SKILL,
      ctx,
      { corrected: [], restated: [] },
      {
        assumptions: [
          `Nenhum lançamento de ${chave} com data divergente; contabilidade já estava alinhada.`,
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }

  const nowIso = ctx.clock.now().toISOString();
  const corrected: AccountingEntry[] = [];
  const restated: AccountingEntry[] = [];
  const pendingItems: PendingItem[] = [];

  for (const original of originais) {
    const dataAntiga = original.entryDate;

    if (!original.exported) {
      const before = { ...original };
      original.entryDate = novaData;
      await ctx.repos.accountingEntries.update(original);
      corrected.push(original);
      await ctx.audit.record(ctx.companyId, {
        actor: ctx.actor,
        action: "accounting.entry_date_corrected",
        entityType: "accounting_entry",
        entityId: original.id,
        before,
        after: original,
        correlationId: ctx.correlationId,
      });
      continue;
    }

    // Já exportado: estorna e relança (mesma mecânica de reverse_entries).
    const inverso: AccountingEntry = {
      id: ctx.ids.next("ae"),
      companyId: ctx.companyId,
      entryDate: ctx.today(),
      debitAccount: original.creditAccount,
      creditAccount: original.debitAccount,
      amountCents: original.amountCents,
      memo: `Estorno de: ${original.memo} (${input.reason})`,
      sourceType: "adjustment",
      sourceId: `rev:${input.sourceId}`,
      exported: false,
      createdAt: nowIso,
    };
    await ctx.repos.accountingEntries.create(inverso);

    const relancado: AccountingEntry = {
      id: ctx.ids.next("ae"),
      companyId: ctx.companyId,
      entryDate: novaData,
      debitAccount: original.debitAccount,
      creditAccount: original.creditAccount,
      amountCents: original.amountCents,
      memo: `${original.memo} (data corrigida: ${input.reason})`,
      sourceType: "adjustment",
      sourceId: `readj:${input.sourceId}`,
      exported: false,
      createdAt: nowIso,
    };
    await ctx.repos.accountingEntries.create(relancado);
    restated.push(inverso, relancado);

    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "accounting.entries_reversed",
      entityType: "accounting_entry",
      entityId: inverso.id,
      before: original,
      after: inverso,
      correlationId: ctx.correlationId,
    });
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "accounting.entry_prepared",
      entityType: "accounting_entry",
      entityId: relancado.id,
      after: relancado,
      correlationId: ctx.correlationId,
    });

    pendingItems.push({
      code: "data_corrigida_apos_exportacao",
      description: `O lançamento ${original.id} (${formatBRL(original.amountCents)}) já havia sido exportado com a data ${dataAntiga}; foi estornado e relançado em ${novaData}.`,
      entityType: "accounting_entry",
      entityId: original.id,
      suggestedAction:
        "Avisar o contador: o próximo lote traz o estorno e o relançamento com a data correta.",
    });
  }

  return makeResult(
    SKILL,
    ctx,
    { corrected, restated },
    {
      assumptions: [
        corrected.length > 0
          ? `${corrected.length} lançamento(s) de ${chave} ainda não exportado(s): data corrigida para ${novaData} no próprio registro.`
          : `Nenhum lançamento pendente de exportação em ${chave}.`,
        restated.length > 0
          ? `${restated.length / 2} lançamento(s) já exportado(s): estornado(s) e relançado(s) em ${novaData} — o que o contador já recebeu não se reescreve.`
          : "Nenhum lançamento já exportado precisou de estorno.",
      ],
      pendingItems,
      dataSources: DATA_SOURCES,
    }
  );
}

async function exportBatch(
  ctx: SkillContext,
  input: ExportBatchInput
): Promise<SkillResult<ExportBatchData>> {
  const start = startOfMonth(input.period);
  const end = endOfMonth(input.period);
  const layout = EXPORT_LAYOUTS[input.layout ?? "padrao"];
  const layoutData = { id: layout.id, name: layout.name, fileExtension: layout.fileExtension };
  const filename = layoutFilename(layout, input.period);
  const formula = `lote = lançamentos com entryDate em [${start}, ${end}] e exported=false; layout "${layout.id}" declarativo (separador "${layout.separator}", data ${layout.dateFormat === "iso" ? "YYYY-MM-DD" : "DD/MM/AAAA"}, valor = centavos/100 com vírgula decimal)`;

  const pending = (
    await ctx.repos.accountingEntries.listByDateRange(ctx.companyId, start, end)
  )
    .filter((e) => !e.exported)
    .sort((a, b) => (a.entryDate === b.entryDate ? (a.id < b.id ? -1 : 1) : a.entryDate < b.entryDate ? -1 : 1));

  if (pending.length === 0) {
    return makeResult(
      SKILL,
      ctx,
      {
        batchId: undefined,
        csv: "",
        count: 0,
        period: input.period,
        layout: layoutData,
        filename,
        formula,
      },
      {
        status: "warning",
        assumptions: [
          ACCOUNTANT_ASSUMPTION,
          `Nenhum lançamento pendente de exportação no período ${input.period}; nenhum lote foi gerado.`,
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }

  const batchId = ctx.ids.next("batch");
  const nowIso = ctx.clock.now().toISOString();
  const lines = renderLayoutLines(layout, pending);
  for (const entry of pending) {
    const before = { ...entry };
    entry.exported = true;
    entry.exportBatchId = batchId;
    await ctx.repos.accountingEntries.update(entry);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "accounting.entry_exported",
      entityType: "accounting_entry",
      entityId: entry.id,
      before,
      after: entry,
      correlationId: ctx.correlationId,
    });
  }
  const csv = lines.join("\n");

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "accounting.batch_exported",
    entityType: "accounting_export_batch",
    entityId: batchId,
    after: {
      batchId,
      period: input.period,
      count: pending.length,
      layout: layout.id,
      filename,
      generatedAt: nowIso,
    },
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "accounting.batch_exported",
    payload: { batchId, period: input.period, count: pending.length, layout: layout.id },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    {
      batchId,
      csv,
      count: pending.length,
      period: input.period,
      layout: layoutData,
      filename,
      formula,
    },
    {
      assumptions: [
        ACCOUNTANT_ASSUMPTION,
        layout.reference,
      ],
      confidence: 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

const VALID_DRE_GROUPS: DreGroup[] = [
  "receita_bruta",
  "deducoes",
  "custos",
  "despesas_operacionais",
  "despesas_financeiras",
  "receitas_financeiras",
  "outras",
];

async function checkMasterData(ctx: SkillContext): Promise<SkillResult<CheckMasterDataData>> {
  const issues: MasterDataIssue[] = [];
  const add = (issue: MasterDataIssue) => issues.push(issue);

  const [payables, receivables, suppliers, customers, categories, costCenters] =
    await Promise.all([
      ctx.repos.payables.listAll(ctx.companyId),
      ctx.repos.receivables.listAll(ctx.companyId),
      ctx.repos.suppliers.listAll(ctx.companyId),
      ctx.repos.customers.listAll(ctx.companyId),
      ctx.repos.categories.listAll(ctx.companyId),
      ctx.repos.costCenters.listAll(ctx.companyId),
    ]);

  const inactiveCostCenters = new Set(costCenters.filter((c) => !c.active).map((c) => c.id));
  const activePayables = payables.filter((p) => p.status !== "canceled");
  const activeReceivables = receivables.filter((r) => r.status !== "canceled");

  for (const p of activePayables) {
    if (!p.categoryId) {
      add({
        type: "titulo_sem_categoria",
        entityType: "payable",
        entityId: p.id,
        description: `Título a pagar ${p.id} (${p.description}) sem categoria de despesa.`,
        suggestedAction: "Classificar o título em uma categoria de despesa.",
      });
    }
    if (p.amountCents <= 0) {
      add({
        type: "titulo_valor_invalido",
        entityType: "payable",
        entityId: p.id,
        description: `Título a pagar ${p.id} com valor inválido (${formatBRL(p.amountCents)}).`,
        suggestedAction: "Corrigir o valor do título ou cancelá-lo.",
      });
    }
    if (p.costCenterId && inactiveCostCenters.has(p.costCenterId)) {
      add({
        type: "centro_custo_inativo",
        entityType: "payable",
        entityId: p.id,
        description: `Título a pagar ${p.id} referencia centro de custo inativo (${p.costCenterId}).`,
        suggestedAction: "Reclassificar o título para um centro de custo ativo.",
      });
    }
  }
  for (const r of activeReceivables) {
    if (!r.categoryId) {
      add({
        type: "titulo_sem_categoria",
        entityType: "receivable",
        entityId: r.id,
        description: `Título a receber ${r.id} (${r.description}) sem categoria de receita.`,
        suggestedAction: "Classificar o título em uma categoria de receita.",
      });
    }
    if (r.amountCents <= 0) {
      add({
        type: "titulo_valor_invalido",
        entityType: "receivable",
        entityId: r.id,
        description: `Título a receber ${r.id} com valor inválido (${formatBRL(r.amountCents)}).`,
        suggestedAction: "Corrigir o valor do título ou cancelá-lo.",
      });
    }
    if (r.costCenterId && inactiveCostCenters.has(r.costCenterId)) {
      add({
        type: "centro_custo_inativo",
        entityType: "receivable",
        entityId: r.id,
        description: `Título a receber ${r.id} referencia centro de custo inativo (${r.costCenterId}).`,
        suggestedAction: "Reclassificar o título para um centro de custo ativo.",
      });
    }
  }
  for (const s of suppliers.filter((x) => x.active)) {
    if (!s.document) {
      add({
        type: "fornecedor_sem_documento",
        entityType: "supplier",
        entityId: s.id,
        description: `Fornecedor ${s.name} (${s.id}) sem CNPJ/CPF cadastrado.`,
        suggestedAction: "Completar o cadastro do fornecedor com CNPJ/CPF.",
      });
    }
  }
  for (const c of customers.filter((x) => x.active)) {
    if (!c.document) {
      add({
        type: "cliente_sem_documento",
        entityType: "customer",
        entityId: c.id,
        description: `Cliente ${c.name} (${c.id}) sem CNPJ/CPF cadastrado.`,
        suggestedAction: "Completar o cadastro do cliente com CNPJ/CPF.",
      });
    }
  }
  for (const c of categories) {
    if (!VALID_DRE_GROUPS.includes(c.dreGroup)) {
      add({
        type: "categoria_dre_invalido",
        entityType: "category",
        entityId: c.id,
        description: `Categoria ${c.name} (${c.id}) com grupo de DRE inválido ("${String(c.dreGroup)}").`,
        suggestedAction: "Corrigir o grupo de DRE da categoria.",
      });
    }
  }

  const pendingItems: PendingItem[] = issues.map((i) => ({
    code: i.type,
    description: i.description,
    entityType: i.entityType,
    entityId: i.entityId,
    suggestedAction: i.suggestedAction,
  }));

  const alerts: SkillAlert[] = [];
  if (issues.length > 0) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "master_data_issues",
      message: `${issues.length} inconsistência(s) cadastral(is) encontrada(s) que podem comprometer a exportação contábil.`,
      entityType: "company",
      entityId: ctx.companyId,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  return makeResult(
    SKILL,
    ctx,
    { issues, count: issues.length },
    {
      alerts,
      pendingItems,
      assumptions: [ACCOUNTANT_ASSUMPTION],
      confidence: 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

async function taxSummary(
  ctx: SkillContext,
  input: TaxSummaryInput
): Promise<SkillResult<TaxSummaryData>> {
  const start = startOfMonth(input.period);
  const end = endOfMonth(input.period);

  const receipts = (
    await ctx.repos.receipts.listByDateRange(ctx.companyId, start, end)
  ).filter(receiptIsActive);
  const cashCents = receipts.reduce((acc, r) => acc + r.amountCents, 0);

  const receivables = (await ctx.repos.receivables.listAll(ctx.companyId)).filter(
    (r) => r.status !== "canceled" && monthOf(r.issueDate) === input.period
  );
  const accrualCents = receivables.reduce((acc, r) => acc + r.amountCents, 0);

  const taxRules = ctx.config.taxRules;
  const regime = typeof taxRules.regime === "string" ? taxRules.regime : "nao_configurado";

  return makeResult(
    SKILL,
    ctx,
    {
      period: { month: input.period, start, end },
      regime,
      taxableRevenueCashCents: cashCents,
      taxableRevenueAccrualCents: accrualCents,
      receiptsCount: receipts.length,
      receivablesCount: receivables.length,
      formula:
        "receita (caixa) = Σ amountCents dos recebimentos com receivedDate no período; receita (competência) = Σ amountCents dos títulos a receber não cancelados com issueDate no período; NENHUM imposto é calculado",
      taxRules,
      observacao:
        "Resumo meramente INFORMATIVO: alíquotas e enquadramento dependem do regime tributário configurado e da validação do contador; nenhum imposto foi calculado ou recolhido.",
    },
    {
      status: "success",
      // Estimativa informativa: bases podem divergir da apuração fiscal oficial.
      confidence: 0.5,
      requiresHumanApproval: false,
      assumptions: [
        ACCOUNTANT_ASSUMPTION,
        `Regime tributário lido da configuração da empresa ("${regime}"); regras tributárias são dados de configuração, nunca código.`,
        "A receita tributável real pode diferir das bases estimadas (devoluções, isenções, substituição tributária e outros ajustes exigem apuração do contador).",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const contabilSkill: SkillDefinition<ContabilInput, ContabilData> = {
  name: SKILL,
  responsibility:
    "Classificar liquidações em lançamentos de partida dobrada, preparar lotes de exportação para a contabilidade, validar cadastros (plano de contas, categorias, centros de custo) e produzir resumo fiscal informativo por regime configurado.",
  objective:
    "Entregar à contabilidade dados classificados, consistentes e exportáveis, sem substituir a validação do contador e sem fixar regra tributária em código.",
  inputSchema: contabilInputSchema,
  consumes: [],
  publishes: ["accounting.entry_prepared", "accounting.batch_exported"],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "prepare_entries":
        return prepareEntries(ctx, input);
      case "reverse_entries":
        return reverseEntries(ctx, input);
      case "restate_entries":
        return restateEntries(ctx, input);
      case "export_batch":
        return exportBatch(ctx, input);
      case "check_master_data":
        return checkMasterData(ctx);
      case "tax_summary":
        return taxSummary(ctx, input);
    }
  },
};
