/**
 * Skill CONTAS A PAGAR — cadastro e classificação de obrigações do fornecedor,
 * controle de vencimentos/parcelas, juros e multas por atraso, agendamento de
 * pagamentos com aprovação humana por alçada, alertas de vencimento, previsão
 * de desembolsos e detecção de duplicidade.
 *
 * Restrição central: esta skill NUNCA movimenta dinheiro por conta própria.
 * Todo pagamento nasce "pending_approval" e só é executado (mock) quando o
 * orquestrador retoma a execução com uma Approval humana registrada.
 */

import { z } from "zod";
import { assertSegregation, hasPermission } from "@/core/auth";
import {
  addDays,
  addMonths,
  diffDays,
  formatBR,
  isISODate,
  minDate,
  toUtcNoon,
  type ISODate,
} from "@/core/dates";
import type { FinancialDocument, Payable, Payment } from "@/core/entities";
import { dueDateForMonth, shouldGenerateFor } from "@/core/recurrence";
import { NotFoundError, PermissionError, ValidationError } from "@/core/errors";
import { hashPayload } from "@/core/ids";
import {
  computeLateFee,
  formatBRL,
  payableRemainingCents,
  splitInstallments,
  type CurrencyCode,
} from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { ApprovalRequestData, PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL = "contas_a_pagar" as const;
const DATA_SOURCES = ["payables", "suppliers", "documents", "payments", "bank_accounts"];

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .refine(isISODate, { message: "data inválida (esperado YYYY-MM-DD)" });

const documentSchema = z.object({
  type: z.enum(["nfe", "nfse", "invoice", "receipt", "contract", "other"]),
  number: z.string().min(1),
  series: z.string().min(1).optional(),
  issuedAt: isoDateSchema,
  totalCents: z.number().int().positive(),
});

// Recorrência: teto de ocorrências materializadas na criação (não há agendador,
// cada ocorrência vira um título real no banco). 60 cobre mensal 5 anos,
// trimestral 15 anos, anual 60 anos, semanal ~14 meses.
export const MAX_RECURRENCE_OCCURRENCES = 60;
export const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"] as const;

const recurrenceSchema = z.object({
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  occurrences: z.number().int().min(2).max(MAX_RECURRENCE_OCCURRENCES),
});

// Objeto base puro (ZodObject) — exigido pelo z.discriminatedUnion. A regra de
// exclusão mútua parcelamento×recorrência é aplicada em createPayableSchema
// (com .refine) e validada no handler; não pode viver no membro da união
// porque .refine produz ZodEffects, que a discriminatedUnion não aceita.
const createPayableObject = z.object({
  action: z.literal("create_payable"),
  supplierId: z.string().min(1),
  description: z.string().min(1),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  amountCents: z.number().int().positive(),
  categoryId: z.string().min(1).optional(),
  costCenterId: z.string().min(1).optional(),
  supplierCategory: z.string().min(1).optional(),
  costClassification: z.enum(["fixed", "variable"]).optional(),
  installmentCount: z.number().int().min(1).max(120).optional(),
  // PARCELAMENTO (installmentCount) divide o valor total; RECORRÊNCIA repete
  // o valor cheio a cada período. São mutuamente exclusivos (ver .refine abaixo).
  recurrence: recurrenceSchema.optional(),
  notes: z.string().optional(),
  document: documentSchema.optional(),
});

// Schema com a regra de exclusão mútua (usado para validar no handler).
const createPayableSchema = createPayableObject.refine(
  (v) => !(v.recurrence && (v.installmentCount ?? 1) > 1),
  {
    message:
      "Parcelamento e recorrência são mutuamente exclusivos: informe apenas um. Parcelamento divide o valor total; recorrência repete o valor cheio a cada período.",
    path: ["recurrence"],
  }
);

const schedulePaymentSchema = z.object({
  action: z.literal("schedule_payment"),
  payableId: z.string().min(1),
  bankAccountId: z.string().min(1),
  scheduledDate: isoDateSchema,
  amountCents: z.number().int().positive().optional(),
});

const listDueSchema = z.object({
  action: z.literal("list_due"),
  withinDays: z.number().int().min(0).optional(),
});

const forecastDisbursementsSchema = z.object({
  action: z.literal("forecast_disbursements"),
  horizonDays: z.number().int().min(1).optional(),
});

const detectDuplicatesSchema = z.object({
  action: z.literal("detect_duplicates"),
});

const cancelPayableSchema = z.object({
  action: z.literal("cancel_payable"),
  payableId: z.string().min(1),
  reason: z.string().min(1),
});

// Edição de título: só campos que NÃO afetam idempotência (originKey) nem
// segregação. Fornecedor, documento e parcela ficam DE FORA de propósito
// (mudá-los muda a originKey / é uma nova obrigação — cancele e recrie).
// O valor é aceito aqui, mas travado no handler conforme a alçada.
const updatePayableSchema = z.object({
  action: z.literal("update_payable"),
  payableId: z.string().min(1),
  description: z.string().min(1),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  amountCents: z.number().int().positive(),
  categoryId: z.string().min(1).nullable().optional(),
  costCenterId: z.string().min(1).nullable().optional(),
  supplierCategory: z.string().min(1).nullable().optional(),
  costClassification: z.enum(["fixed", "variable"]).nullable().optional(),
  notes: z.string().nullable().optional(),
});

// Correção da DATA DE PAGAMENTO de um pagamento já conciliado. Existe porque
// `reconcile_payment` é idempotente e não reedita (volta sem efeito quando o
// pagamento já está executado), e porque `update_payable` recusa título pago —
// e deve continuar recusando. Aqui o contrato é de UM campo só.
const adjustPaymentDateSchema = z.object({
  action: z.literal("adjust_payment_date"),
  paymentId: z.string().min(1),
  paymentDate: isoDateSchema,
});

// Conciliação do pagamento aprovado: informa a data em que o dinheiro saiu de
// fato e baixa o título. É esta data — não a da aprovação — que decide se o
// título fica "Pago" ou "Pago Atrasado".
const reconcilePaymentSchema = z.object({
  action: z.literal("reconcile_payment"),
  paymentId: z.string().min(1),
  paymentDate: isoDateSchema,
});

// Estorno de pagamento JÁ EXECUTADO: desfaz a baixa e devolve o título para
// Contas a pagar. Nada é apagado — o pagamento fica "canceled" e a trilha de
// auditoria guarda o antes/depois com o motivo informado.
const reversePaymentSchema = z.object({
  action: z.literal("reverse_payment"),
  paymentId: z.string().min(1),
  reason: z.string().min(1),
});

const generateRecurringSchema = z.object({
  action: z.literal("generate_recurring"),
});

export const contasAPagarInputSchema = z.discriminatedUnion("action", [
  createPayableObject,
  schedulePaymentSchema,
  listDueSchema,
  forecastDisbursementsSchema,
  detectDuplicatesSchema,
  cancelPayableSchema,
  updatePayableSchema,
  adjustPaymentDateSchema,
  reconcilePaymentSchema,
  reversePaymentSchema,
  generateRecurringSchema,
]);

export type CreatePayableInput = z.infer<typeof createPayableSchema>;
export type SchedulePaymentInput = z.infer<typeof schedulePaymentSchema>;
export type ListDueInput = z.infer<typeof listDueSchema>;
export type ForecastDisbursementsInput = z.infer<typeof forecastDisbursementsSchema>;
export type DetectDuplicatesInput = z.infer<typeof detectDuplicatesSchema>;
export type CancelPayableInput = z.infer<typeof cancelPayableSchema>;
export type UpdatePayableInput = z.infer<typeof updatePayableSchema>;
export type AdjustPaymentDateInput = z.infer<typeof adjustPaymentDateSchema>;
export type ReconcilePaymentInput = z.infer<typeof reconcilePaymentSchema>;
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;
export type GenerateRecurringInput = z.infer<typeof generateRecurringSchema>;
export type ContasAPagarInput = z.infer<typeof contasAPagarInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface CreatePayableData {
  payables: Payable[];
  document?: FinancialDocument;
  formula: string;
}

export interface SchedulePaymentData {
  payment: Payment;
  approvalRequest?: ApprovalRequestData;
}

export interface DuePayableEntry {
  payableId: string;
  supplierId: string;
  description: string;
  status: Payable["status"];
  dueDate: ISODate;
  amountCents: number;
  paidCents: number;
  remainingCents: number;
  daysLate: number;
  fineCents: number;
  interestCents: number;
  totalDueCents: number;
  formula: string;
}

export interface ListDueData {
  due: DuePayableEntry[];
  totalDueCents: number;
  period: { start: ISODate; end: ISODate };
  formula: string;
}

export interface ForecastWeek {
  weekStart: ISODate;
  weekEnd: ISODate;
  totalCents: number;
  count: number;
}

export interface ForecastDisbursementsData {
  horizonDays: number;
  weekly: ForecastWeek[];
  totalCents: number;
  period: { start: ISODate; end: ISODate };
  formula: string;
}

export interface DuplicateSuspect {
  payableIds: string[];
  reason: string;
}

export interface DetectDuplicatesData {
  suspects: DuplicateSuspect[];
}

export interface CancelPayableData {
  payable: Payable;
  reason: string;
}

export interface UpdatePayableData {
  payable: Payable;
}

export interface AdjustPaymentDateData {
  payment: Payment;
  payable: Payable;
}

export interface ReconcilePaymentData {
  payment: Payment;
  payable: Payable;
}

export interface ReversePaymentData {
  payment: Payment;
  payable: Payable;
  reason: string;
}

export interface GenerateRecurringData {
  /** Títulos criados nesta rodada (vazio se nada era devido ou já existia). */
  generated: Array<{ templateId: string; payableId: string; dueDate: string }>;
}

export type ContasAPagarData =
  | CreatePayableData
  | SchedulePaymentData
  | ListDueData
  | ForecastDisbursementsData
  | DetectDuplicatesData
  | CancelPayableData
  | UpdatePayableData
  | AdjustPaymentDateData
  | ReconcilePaymentData
  | ReversePaymentData
  | GenerateRecurringData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_STATUSES: Payable["status"][] = ["open", "partially_paid", "scheduled"];

/**
 * Persiste um alerta apenas se não houver outro ABERTO com mesmo code+entityId
 * (dedupe exigido para não inflar o painel a cada reexecução da skill).
 */
async function persistAlertDeduped(ctx: SkillContext, alert: SkillAlert): Promise<void> {
  const open = await ctx.repos.alerts.listOpen(ctx.companyId);
  const exists = open.some((a) => a.code === alert.code && a.entityId === alert.entityId);
  if (exists) return;
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

async function resolveCurrency(ctx: SkillContext): Promise<CurrencyCode> {
  const company = await ctx.repos.companies.getById(ctx.companyId);
  return company?.defaultCurrency ?? "BRL";
}

/**
 * Regras comuns a criar e editar um título: vencimento não anterior à emissão,
 * e existência de categoria/centro de custo quando informados. Mensagens e
 * exceções idênticas às que create_payable já aplicava (extraídas, não
 * duplicadas), para que a edição valide exatamente o mesmo.
 */
async function assertPayableFieldsValid(
  ctx: SkillContext,
  fields: {
    issueDate: ISODate;
    dueDate: ISODate;
    categoryId?: string | null;
    costCenterId?: string | null;
  }
): Promise<void> {
  if (fields.dueDate < fields.issueDate) {
    // Mensagem amigável (datas em pt-BR, nunca ISO). Mesma exceção/código de
    // antes; usada por create e update (função compartilhada).
    throw new ValidationError(
      `Verificar a Data da Emissão (vencimento ${formatBR(fields.dueDate)} é anterior à emissão ${formatBR(fields.issueDate)}).`
    );
  }
  if (fields.categoryId) {
    const category = await ctx.repos.categories.getById(ctx.companyId, fields.categoryId);
    if (!category) throw new NotFoundError("Categoria", fields.categoryId);
  }
  if (fields.costCenterId) {
    const costCenter = await ctx.repos.costCenters.getById(ctx.companyId, fields.costCenterId);
    if (!costCenter) throw new NotFoundError("Centro de custo", fields.costCenterId);
  }
}

type RecurrenceFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * Vencimento da ocorrência `i` (0-based) de uma recorrência, a partir do
 * vencimento base. Reaproveita addDays/addMonths de core/dates (addMonths já
 * faz o clamp de fim de mês: 31/01 → 28/02, preservando o dia nos meses que o
 * comportam). NÃO usa aritmética ingênua de dias.
 */
function recurrenceDueDate(base: ISODate, frequency: RecurrenceFrequency, i: number): ISODate {
  switch (frequency) {
    case "weekly":
      return addDays(base, 7 * i);
    case "monthly":
      return addMonths(base, i);
    case "quarterly":
      return addMonths(base, 3 * i);
    case "yearly":
      return addMonths(base, 12 * i);
  }
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function createPayable(
  ctx: SkillContext,
  input: CreatePayableInput
): Promise<SkillResult<CreatePayableData>> {
  const assumptions: string[] = [];
  const alerts: SkillAlert[] = [];
  const pendingItems: PendingItem[] = [];
  let confidence = 1.0;

  // Exclusão mútua parcelamento×recorrência (regra do schema; aplicada aqui
  // porque o membro da discriminatedUnion não pode carregar .refine).
  const refined = createPayableSchema.safeParse(input);
  if (!refined.success) {
    throw new ValidationError(refined.error.issues[0]?.message ?? "Entrada inválida.");
  }

  const supplier = await ctx.repos.suppliers.getById(ctx.companyId, input.supplierId);
  if (!supplier) throw new NotFoundError("Fornecedor", input.supplierId);
  if (!supplier.active) {
    throw new ValidationError(`Fornecedor inativo: ${supplier.name} (${supplier.id}).`);
  }
  await assertPayableFieldsValid(ctx, {
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    categoryId: input.categoryId,
    costCenterId: input.costCenterId,
  });

  const currency = await resolveCurrency(ctx);
  const nowIso = ctx.clock.now().toISOString();

  // Documento fiscal: dedupe por hash de conteúdo (mesmo documento não entra 2x).
  let document: FinancialDocument | undefined;
  if (input.document) {
    const contentHash = hashPayload(input.document);
    const existing = await ctx.repos.documents.findByContentHash(ctx.companyId, contentHash);
    if (existing) {
      document = existing;
      const alert: SkillAlert = {
        severity: "warning",
        code: "duplicate_document",
        message: `Documento ${input.document.number} já registrado (hash idêntico); registro existente reutilizado.`,
        entityType: "financial_document",
        entityId: existing.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
      assumptions.push(
        "Documento fiscal com conteúdo idêntico já existia; nenhum novo documento foi criado."
      );
    } else {
      document = await ctx.repos.documents.create({
        id: ctx.ids.next("doc"),
        companyId: ctx.companyId,
        type: input.document.type,
        number: input.document.number,
        series: input.document.series,
        issuerName: supplier.name,
        issuerDoc: supplier.document,
        issuedAt: input.document.issuedAt,
        totalCents: input.document.totalCents,
        contentHash,
        createdAt: nowIso,
      });
    }
  }

  // Classificação: sem categoria informada, a IA apenas SUGERE (nunca decide sozinha
  // sem registro explícito da suposição e rebaixamento da confiança do resultado).
  let categoryId = input.categoryId;
  let classifiedByAi = false;
  if (!categoryId) {
    const candidates = (await ctx.repos.categories.listAll(ctx.companyId))
      .filter((c) => c.kind === "expense" && c.active)
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
    const suggestion = await ctx.ai.suggestCategory(input.description, candidates);
    if (suggestion.categoryId) {
      categoryId = suggestion.categoryId;
      classifiedByAi = true;
      confidence = Math.min(confidence, suggestion.confidence);
      assumptions.push(
        `Categoria aplicada por sugestão automática (provedor "${ctx.ai.provider}", confiança ${suggestion.confidence}): ${suggestion.rationale}`
      );
    }
  }

  // Dois modos MUTUAMENTE EXCLUSIVOS:
  //  - recorrência: `count` ocorrências, cada uma com o valor INTEGRAL, vencimento
  //    avançando pela frequência; originKey marcada com "R-<freq>" p/ não colidir.
  //  - parcelamento (ou título simples): comportamento original — valor dividido,
  //    vencimento avançando 1 mês por parcela.
  const recurrence = input.recurrence;
  const count = recurrence ? recurrence.occurrences : input.installmentCount ?? 1;
  const amounts = recurrence
    ? Array.from({ length: count }, () => input.amountCents) // valor cheio a cada ocorrência
    : splitInstallments(input.amountCents, count);
  // Sem documento, a chave natural inclui emissão/vencimento para não confundir
  // obrigações recorrentes (ex.: "Aluguel" de agosto vs. de setembro, mesmo
  // valor). O lado de contas a receber já segue essa convenção.
  const documentRef =
    input.document?.number ??
    hashPayload({
      description: input.description,
      amountCents: input.amountCents,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
    }).slice(0, 12);
  // Marcador de série na originKey: recorrência ganha "R-<freq>" para nunca
  // colidir com um parcelamento de mesmo fornecedor/documento/total.
  const seriesTag = recurrence ? `R-${recurrence.frequency}:` : "";
  const positionLabel = recurrence ? "ocorrência" : "parcela";

  const payables: Payable[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const originKey = `${input.supplierId}:${documentRef}:${seriesTag}${n}/${count}`;
    const existing = await ctx.repos.payables.findByOriginKey(ctx.companyId, originKey);
    if (existing) {
      // Idempotência: repetir a mesma entrada não duplica títulos.
      payables.push(existing);
      assumptions.push(
        `${positionLabel[0].toUpperCase()}${positionLabel.slice(1)} ${n}/${count} já cadastrada (originKey "${originKey}"); título existente ${existing.id} reutilizado sem criar duplicata.`
      );
      // Reuso de um título já quitado/cancelado costuma indicar uma nova
      // obrigação com a mesma chave — sinaliza para revisão humana.
      if (existing.status === "paid" || existing.status === "canceled") {
        pendingItems.push({
          code: "reuso_titulo_encerrado",
          description: `Título existente ${existing.id} está ${existing.status}; a nova entrada foi tratada como repetição idempotente.`,
          entityType: "payable",
          entityId: existing.id,
          suggestedAction:
            "Se esta é uma nova obrigação (ex.: recorrência), altere emissão/vencimento ou informe o documento para diferenciá-la.",
        });
      }
      continue;
    }
    const multiple = count > 1;
    const dueDate = recurrence
      ? recurrenceDueDate(input.dueDate, recurrence.frequency, i)
      : addMonths(input.dueDate, i);
    const payable: Payable = {
      id: ctx.ids.next("payb"),
      companyId: ctx.companyId,
      supplierId: input.supplierId,
      documentId: document?.id,
      description: multiple
        ? `${input.description} (${positionLabel} ${n}/${count})`
        : input.description,
      issueDate: input.issueDate, // emissão fixa em toda a série (ver análise Q4)
      dueDate,
      amountCents: amounts[i],
      paidCents: 0,
      currency,
      status: "open",
      categoryId,
      costCenterId: input.costCenterId,
      supplierCategory: input.supplierCategory,
      costClassification: input.costClassification,
      installmentNumber: n,
      installmentCount: count,
      originKey,
      notes: input.notes,
      createdBy: ctx.actor.id,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await ctx.repos.payables.create(payable);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "payable.created",
      entityType: "payable",
      entityId: payable.id,
      after: payable,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "payable.created",
      payload: { id: payable.id, amountCents: payable.amountCents, dueDate: payable.dueDate },
      source: SKILL,
      correlationId: ctx.correlationId,
    });
    payables.push(payable);
  }

  if (!categoryId) {
    for (const p of payables) {
      pendingItems.push({
        code: "sem_categoria",
        description: `Título ${p.id} criado sem categoria de despesa.`,
        entityType: "payable",
        entityId: p.id,
        suggestedAction: "Classificar manualmente o título em uma categoria de despesa.",
      });
    }
  }

  return makeResult(
    SKILL,
    ctx,
    {
      payables,
      document,
      formula: recurrence
        ? `recorrência ${recurrence.frequency}: ${count} ocorrência(s) de ${input.amountCents} (valor cheio); vencimento da ocorrência n = base avançado ${recurrence.frequency}; total comprometido = ${input.amountCents} × ${count}`
        : `parcelas = splitInstallments(${input.amountCents}, ${count}); vencimento da parcela n = dueDate + (n-1) mês; soma das parcelas = total exato`,
    },
    {
      alerts,
      pendingItems,
      assumptions,
      confidence: classifiedByAi ? confidence : 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

async function schedulePayment(
  ctx: SkillContext,
  input: SchedulePaymentInput
): Promise<SkillResult<SchedulePaymentData>> {
  if (ctx.approval) return resumePaymentDecision(ctx);

  const payable = await ctx.repos.payables.getById(ctx.companyId, input.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", input.payableId);
  if (!OPEN_STATUSES.includes(payable.status)) {
    throw new ValidationError(
      `Título ${payable.id} não permite agendamento (status atual: ${payable.status}).`
    );
  }
  const account = await ctx.repos.bankAccounts.getById(ctx.companyId, input.bankAccountId);
  if (!account) throw new NotFoundError("Conta bancária", input.bankAccountId);
  if (!account.active) {
    throw new ValidationError(`Conta bancária inativa: ${account.name} (${account.id}).`);
  }

  // Saldo disponível = saldo em aberto (amount - paid) MENOS o que já está
  // reservado por pagamentos ainda não executados (pending_approval/approved).
  // Sem esse desconto, dois agendamentos simultâneos do valor integral gerariam
  // dupla baixa ao serem ambos aprovados.
  const existingPayments = await ctx.repos.payments.listByPayable(ctx.companyId, payable.id);
  const reservedCents = existingPayments
    .filter((p) => p.status === "pending_approval" || p.status === "approved")
    .reduce((acc, p) => acc + p.amountCents, 0);
  const available = payableRemainingCents(payable) - reservedCents;
  const amount = input.amountCents ?? available;
  if (available <= 0) {
    throw new ValidationError(
      `Título ${payable.id} não possui saldo disponível para agendamento (saldo já reservado por pagamento pendente).`
    );
  }
  if (amount > available) {
    throw new ValidationError(
      `Valor do pagamento (${formatBRL(amount)}) excede o saldo disponível do título ` +
        `(${formatBRL(available)}; parte do saldo já está reservada por pagamento pendente).`
    );
  }

  const nowIso = ctx.clock.now().toISOString();
  const payment: Payment = {
    id: ctx.ids.next("pay"),
    companyId: ctx.companyId,
    payableId: payable.id,
    bankAccountId: account.id,
    amountCents: amount,
    scheduledDate: input.scheduledDate,
    status: "pending_approval",
    requestedBy: ctx.actor.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await ctx.repos.payments.create(payment);

  const payableBefore = { ...payable };
  payable.status = "scheduled";
  payable.updatedAt = nowIso;
  await ctx.repos.payables.update(payable);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payment.requested",
    entityType: "payment",
    entityId: payment.id,
    after: payment,
    correlationId: ctx.correlationId,
  });
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payable.updated",
    entityType: "payable",
    entityId: payable.id,
    before: payableBefore,
    after: payable,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payment.scheduled",
    payload: {
      id: payment.id,
      payableId: payable.id,
      amountCents: amount,
      scheduledDate: payment.scheduledDate,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  const supplier = await ctx.repos.suppliers.getById(ctx.companyId, payable.supplierId);
  const approvalRequest: ApprovalRequestData = {
    targetType: "payment",
    targetId: payment.id,
    summary: `Pagamento de ${supplier?.name ?? payable.supplierId} — ${formatBRL(amount)}`,
    amountCents: amount,
    // A alçada considera o TÍTULO inteiro: fracionar o pagamento não reduz o
    // papel/nº de aprovações exigidos.
    tierAmountCents: payable.amountCents,
  };

  return makeResult(
    SKILL,
    ctx,
    { payment, approvalRequest },
    {
      status: "awaiting_approval",
      requiresHumanApproval: true,
      assumptions: [
        "Nenhum valor foi movimentado: o pagamento foi registrado como pendente e aguarda aprovação humana conforme a alçada configurada.",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

/** Retomada pós-decisão humana: executa (mock) ou cancela o pagamento pendente. */
async function resumePaymentDecision(ctx: SkillContext): Promise<SkillResult<SchedulePaymentData>> {
  const decision = ctx.approval;
  if (!decision) throw new ValidationError("Retomada sem decisão de aprovação no contexto.");

  // Confere a Approval persistida antes de qualquer efeito — a decisão do
  // contexto nunca é aceita sem o registro correspondente no repositório.
  const approvalRecord = await ctx.repos.approvals.getById(ctx.companyId, decision.id);
  if (!approvalRecord) throw new NotFoundError("Aprovação", decision.id);
  if (approvalRecord.targetType !== "payment") {
    throw new ValidationError(
      `Aprovação ${approvalRecord.id} não se refere a um pagamento (targetType: ${approvalRecord.targetType}).`
    );
  }
  if (approvalRecord.status !== decision.status) {
    throw new ValidationError(
      `Decisão informada (${decision.status}) diverge do registro de aprovação (${approvalRecord.status}).`
    );
  }

  const payment = await ctx.repos.payments.getById(ctx.companyId, approvalRecord.targetId);
  if (!payment) throw new NotFoundError("Pagamento", approvalRecord.targetId);

  // Idempotência da retomada: decisão já aplicada não gera novo efeito. Depois
  // da aprovação o pagamento fica "approved" (aguardando conciliação) e, uma
  // vez conciliado, "executed" — nenhum dos dois volta a ser decidido.
  if (
    decision.status === "approved" &&
    (payment.status === "approved" || payment.status === "executed")
  ) {
    return makeResult(
      SKILL,
      ctx,
      { payment },
      {
        assumptions: [
          payment.status === "executed"
            ? "Pagamento já havia sido conciliado e executado; retomada idempotente sem novo efeito."
            : "Pagamento já havia sido aprovado e aguarda conciliação; retomada idempotente sem novo efeito.",
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (decision.status === "rejected" && payment.status === "rejected") {
    return makeResult(
      SKILL,
      ctx,
      { payment },
      {
        assumptions: ["Pagamento já havia sido rejeitado; retomada idempotente sem novo efeito."],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (payment.status !== "pending_approval") {
    throw new ValidationError(
      `Pagamento ${payment.id} não está pendente de aprovação (status atual: ${payment.status}).`
    );
  }

  const payable = await ctx.repos.payables.getById(ctx.companyId, payment.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", payment.payableId);

  const nowIso = ctx.clock.now().toISOString();
  const paymentBefore = { ...payment };
  const payableBefore = { ...payable };

  if (decision.status === "approved") {
    // Segregação de funções também na skill (defesa em profundidade). O e-mail
    // do aprovador entra por causa da exceção nominal (ver auth.ts); sem ele,
    // esta segunda barreira barraria a autoaprovação que o orquestrador liberou.
    // Só consulta quando aprovador e solicitante são a mesma pessoa.
    const approverEmail =
      payment.requestedBy === decision.decidedBy
        ? (await ctx.repos.users.getById(decision.decidedBy))?.email
        : undefined;
    assertSegregation(payment.requestedBy, decision.decidedBy, approverEmail);

    // Revalida o saldo já na aprovação: aprovar um valor que não cabe mais no
    // título só adiaria o erro para a conciliação (que revalida de novo).
    if (payment.amountCents > payableRemainingCents(payable)) {
      throw new ValidationError(
        `Pagamento ${payment.id} (${formatBRL(payment.amountCents)}) excede o saldo restante ` +
          `do título ${payable.id} (${formatBRL(payableRemainingCents(payable))}) no momento da aprovação.`
      );
    }

    // A aprovação NÃO baixa mais o título: ela autoriza o pagamento, que fica
    // "approved" aguardando a CONCILIAÇÃO. Quem baixa é reconcilePayment, com a
    // data real em que o dinheiro saiu — é essa data que decide "Pago" ou
    // "Pago Atrasado". O título continua "scheduled" (segue em Contas a pagar).
    payment.status = "approved";
    payment.approvalId = decision.id;
    payment.updatedAt = nowIso;
    await ctx.repos.payments.update(payment);

    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "payment.approved",
      entityType: "payment",
      entityId: payment.id,
      before: paymentBefore,
      after: payment,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "payment.approved",
      payload: {
        id: payment.id,
        payableId: payable.id,
        amountCents: payment.amountCents,
        approvedBy: decision.decidedBy,
      },
      source: SKILL,
      correlationId: ctx.correlationId,
    });

    return makeResult(
      SKILL,
      ctx,
      { payment },
      {
        assumptions: [
          `Pagamento aprovado por ${decision.decidedBy}. Nenhuma baixa foi feita: o título só é quitado na CONCILIAÇÃO, com a data real do pagamento.`,
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }

  // Rejeitado: cancela o pagamento pendente e devolve o título ao estado aberto.
  payment.status = "rejected";
  payment.approvalId = decision.id;
  payment.updatedAt = nowIso;
  await ctx.repos.payments.update(payment);

  // Título com pagamento parcial anterior permanece "partially_paid".
  payable.status = payable.paidCents > 0 ? "partially_paid" : "open";
  payable.updatedAt = nowIso;
  await ctx.repos.payables.update(payable);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payment.rejected",
    entityType: "payment",
    entityId: payment.id,
    before: paymentBefore,
    after: payment,
    correlationId: ctx.correlationId,
  });
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payable.updated",
    entityType: "payable",
    entityId: payable.id,
    before: payableBefore,
    after: payable,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payable.updated",
    payload: { id: payable.id, status: payable.status, paidCents: payable.paidCents },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    { payment },
    {
      assumptions: [
        `Pagamento rejeitado por ${decision.decidedBy}${decision.justification ? ` (justificativa: ${decision.justification})` : ""}; agendamento cancelado e título devolvido ao status "${payable.status}". Nenhum valor foi movimentado.`,
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

async function listDue(ctx: SkillContext, input: ListDueInput): Promise<SkillResult<ListDueData>> {
  const withinDays = input.withinDays ?? 7;
  const today = ctx.today();
  const end = addDays(today, withinDays);
  const assumptions: string[] = [];
  if (input.withinDays === undefined) {
    assumptions.push("Janela padrão de 7 dias aplicada (withinDays não informado).");
  }

  const openPayables = await ctx.repos.payables.listByStatus(ctx.companyId, OPEN_STATUSES);
  const dueList = openPayables
    .filter((p) => p.dueDate <= end)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  const alerts: SkillAlert[] = [];
  const due: DuePayableEntry[] = [];
  for (const p of dueList) {
    const remaining = payableRemainingCents(p);
    const daysLate = Math.max(0, diffDays(p.dueDate, today));
    const late = computeLateFee(remaining, daysLate, ctx.config.lateFeeDefaults);
    due.push({
      payableId: p.id,
      supplierId: p.supplierId,
      description: p.description,
      status: p.status,
      dueDate: p.dueDate,
      amountCents: p.amountCents,
      paidCents: p.paidCents,
      remainingCents: remaining,
      daysLate: late.daysLate,
      fineCents: late.fineCents,
      interestCents: late.interestCents,
      totalDueCents: late.totalCents,
      formula: daysLate > 0 ? late.formula : "total = saldo restante (sem atraso)",
    });

    if (daysLate > 0) {
      const alert: SkillAlert = {
        severity: "critical",
        code: "payable_overdue",
        message: `Título ${p.id} vencido há ${daysLate} dia(s) — saldo com encargos: ${formatBRL(late.totalCents)}.`,
        entityType: "payable",
        entityId: p.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
    } else if (diffDays(today, p.dueDate) <= 3) {
      const alert: SkillAlert = {
        severity: "warning",
        code: "payable_due_soon",
        message: `Título ${p.id} vence em ${diffDays(today, p.dueDate)} dia(s) (${p.dueDate}) — saldo: ${formatBRL(remaining)}.`,
        entityType: "payable",
        entityId: p.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
    }
  }

  const totalDueCents = due.reduce((acc, d) => acc + d.totalDueCents, 0);
  return makeResult(
    SKILL,
    ctx,
    {
      due,
      totalDueCents,
      period: { start: today, end },
      formula: `totalDueCents = Σ [saldo restante + multa (${ctx.config.lateFeeDefaults.finePercent}%) + juros (${ctx.config.lateFeeDefaults.monthlyInterestPercent}% a.m. pró-rata die)] dos títulos abertos com vencimento até ${end}`,
    },
    { alerts, assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

async function forecastDisbursements(
  ctx: SkillContext,
  input: ForecastDisbursementsInput
): Promise<SkillResult<ForecastDisbursementsData>> {
  const horizonDays = input.horizonDays ?? 30;
  const today = ctx.today();
  const end = addDays(today, horizonDays);
  const assumptions: string[] = [
    "Previsão assume pagamento integral do saldo restante na data de vencimento de cada título.",
  ];
  if (input.horizonDays === undefined) {
    assumptions.push("Horizonte padrão de 30 dias aplicado (horizonDays não informado).");
  }

  const openPayables = (await ctx.repos.payables.listByStatus(ctx.companyId, OPEN_STATUSES)).filter(
    (p) => p.dueDate <= end
  );

  const weekCount = Math.max(1, Math.ceil(horizonDays / 7));
  const weekly: ForecastWeek[] = Array.from({ length: weekCount }, (_, i) => {
    const weekStart = addDays(today, i * 7);
    return { weekStart, weekEnd: minDate(addDays(weekStart, 6), end), totalCents: 0, count: 0 };
  });

  let overdueClamped = 0;
  for (const p of openPayables) {
    // Vencidos entram na semana atual: são desembolsos imediatos previstos.
    const effectiveDate = p.dueDate < today ? today : p.dueDate;
    if (p.dueDate < today) overdueClamped += 1;
    const weekIndex = Math.min(Math.floor(diffDays(today, effectiveDate) / 7), weekCount - 1);
    weekly[weekIndex].totalCents += payableRemainingCents(p);
    weekly[weekIndex].count += 1;
  }
  if (overdueClamped > 0) {
    assumptions.push(
      `${overdueClamped} título(s) vencido(s) alocado(s) na semana atual como desembolso imediato previsto.`
    );
  }

  const totalCents = weekly.reduce((acc, w) => acc + w.totalCents, 0);
  return makeResult(
    SKILL,
    ctx,
    {
      horizonDays,
      weekly,
      totalCents,
      period: { start: today, end },
      formula:
        "desembolso da semana k = Σ saldo restante (amountCents - paidCents) dos títulos abertos com vencimento em [hoje+7k, hoje+7k+6]; vencidos contam na semana atual",
    },
    // Previsão é estimativa (datas reais de pagamento podem variar) → confiança < 1.
    { assumptions, confidence: 0.9, dataSources: DATA_SOURCES }
  );
}

async function detectDuplicates(ctx: SkillContext): Promise<SkillResult<DetectDuplicatesData>> {
  const payables = (await ctx.repos.payables.listAll(ctx.companyId)).filter(
    (p) => p.status !== "canceled"
  );

  const suspects: DuplicateSuspect[] = [];
  const seenPairs = new Set<string>();

  const addSuspect = (a: Payable, b: Payable, reason: string) => {
    const ids = [a.id, b.id].sort();
    const pairKey = ids.join("+");
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);
    suspects.push({ payableIds: ids, reason });
  };

  // Regra 1: mesmo fornecedor + valor + vencimento, com originKey diferente.
  const byKey = new Map<string, Payable[]>();
  for (const p of payables) {
    const key = `${p.supplierId}|${p.amountCents}|${p.dueDate}`;
    const list = byKey.get(key) ?? [];
    list.push(p);
    byKey.set(key, list);
  }
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].originKey !== group[j].originKey) {
          addSuspect(
            group[i],
            group[j],
            `Mesmo fornecedor (${group[i].supplierId}), valor (${formatBRL(group[i].amountCents)}) e vencimento (${group[i].dueDate}) com chaves de origem distintas.`
          );
        }
      }
    }
  }

  // Regra 2: dois títulos vinculados ao mesmo documento fiscal e mesma parcela.
  const byDocument = new Map<string, Payable[]>();
  for (const p of payables) {
    if (!p.documentId) continue;
    const key = `${p.documentId}|${p.installmentNumber}`;
    const list = byDocument.get(key) ?? [];
    list.push(p);
    byDocument.set(key, list);
  }
  for (const group of byDocument.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        addSuspect(
          group[i],
          group[j],
          `Mesmo documento fiscal (${group[i].documentId}) vinculado à mesma parcela (${group[i].installmentNumber}).`
        );
      }
    }
  }

  const alerts: SkillAlert[] = [];
  for (const suspect of suspects) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "possible_duplicate_payable",
      message: `Possível duplicidade entre os títulos ${suspect.payableIds.join(" e ")}: ${suspect.reason}`,
      entityType: "payable",
      entityId: suspect.payableIds.join("+"),
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  return makeResult(
    SKILL,
    ctx,
    { suspects },
    {
      // Heurística de similaridade — pares são SUSPEITOS, não confirmação de duplicidade.
      confidence: 0.8,
      alerts,
      assumptions: [
        "Detecção heurística: pares apontados são suspeitos de duplicidade e exigem confirmação humana antes de qualquer cancelamento.",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

async function cancelPayable(
  ctx: SkillContext,
  input: CancelPayableInput
): Promise<SkillResult<CancelPayableData>> {
  if (ctx.actor.type === "user") {
    if (!ctx.actor.role || !hasPermission(ctx.actor.role, "payable.cancel")) {
      throw new PermissionError(
        `Usuário ${ctx.actor.id} (papel ${ctx.actor.role ?? "nenhum"}) não pode cancelar títulos a pagar.`
      );
    }
  }

  const payable = await ctx.repos.payables.getById(ctx.companyId, input.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", input.payableId);

  if (payable.status === "canceled") {
    return makeResult(
      SKILL,
      ctx,
      { payable, reason: input.reason },
      {
        assumptions: ["Título já estava cancelado; nenhuma alteração adicional foi feita."],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (payable.status !== "open" && payable.status !== "scheduled") {
    throw new ValidationError(
      `Título ${payable.id} não pode ser cancelado (status atual: ${payable.status}).`
    );
  }
  const payments = await ctx.repos.payments.listByPayable(ctx.companyId, payable.id);
  if (payable.paidCents > 0 || payments.some((p) => p.status === "executed")) {
    throw new ValidationError(
      `Título ${payable.id} possui pagamento executado e não pode ser cancelado.`
    );
  }

  const nowIso = ctx.clock.now().toISOString();
  const assumptions: string[] = [];

  // Pagamentos ainda não executados vinculados ao título são cancelados junto.
  for (const payment of payments) {
    if (payment.status !== "pending_approval" && payment.status !== "approved") continue;
    const before = { ...payment };
    payment.status = "canceled";
    payment.updatedAt = nowIso;
    await ctx.repos.payments.update(payment);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "payment.canceled",
      entityType: "payment",
      entityId: payment.id,
      before,
      after: payment,
      correlationId: ctx.correlationId,
    });
    assumptions.push(`Pagamento pendente ${payment.id} cancelado junto com o título.`);
  }

  const before = { ...payable };
  payable.status = "canceled";
  payable.canceledAt = nowIso;
  payable.updatedAt = nowIso;
  await ctx.repos.payables.update(payable);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payable.canceled",
    entityType: "payable",
    entityId: payable.id,
    before,
    after: { ...payable, cancelReason: input.reason },
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payable.canceled",
    payload: { id: payable.id, reason: input.reason },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    { payable, reason: input.reason },
    { assumptions, dataSources: DATA_SOURCES }
  );
}

/**
 * Edita um título a pagar. Só campos que não afetam idempotência (originKey) nem
 * segregação: descrição, datas, categoria, centro de custo, categoria de
 * fornecedor, classificação de custo e notas — e o valor SOMENTE quando não há
 * movimento financeiro nem pagamento reservando alçada.
 *
 * Regras (ver análise da Etapa 0):
 *  - Título paid/canceled ou com paidCents > 0: não editável (movimento financeiro).
 *  - Valor (amountCents): travado se houver Payment pending_approval/approved,
 *    senão a alçada calculada sobre o valor antigo seria contornada.
 *  - Reaplica as validações do create (vencimento ≥ emissão, categoria/centro
 *    existem) via assertPayableFieldsValid.
 *  - Fornecedor, documento e parcela NÃO entram no schema: a originKey fica
 *    congelada por construção.
 */
async function updatePayable(
  ctx: SkillContext,
  input: UpdatePayableInput
): Promise<SkillResult<UpdatePayableData>> {
  if (ctx.actor.type === "user") {
    if (!ctx.actor.role || !hasPermission(ctx.actor.role, "payable.create")) {
      throw new PermissionError(
        `Usuário ${ctx.actor.id} (papel ${ctx.actor.role ?? "nenhum"}) não pode editar títulos a pagar.`
      );
    }
  }

  const payable = await ctx.repos.payables.getById(ctx.companyId, input.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", input.payableId);

  // Título encerrado ou com movimento financeiro não é editável.
  if (payable.status === "paid" || payable.status === "canceled") {
    throw new ValidationError(
      `Título ${payable.id} está ${payable.status} e não pode ser editado.`
    );
  }
  if (payable.paidCents > 0) {
    throw new ValidationError(
      `Título ${payable.id} já possui pagamento realizado (${formatBRL(payable.paidCents)}) e não pode ser editado. Cancele o pagamento para alterá-lo.`
    );
  }

  // Regras comuns ao create (vencimento ≥ emissão, categoria/centro existem).
  await assertPayableFieldsValid(ctx, {
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    categoryId: input.categoryId,
    costCenterId: input.costCenterId,
  });

  // Trava do valor: mudar amountCents com pagamento reservando alçada
  // contornaria a faixa de aprovação (a Approval carimba tierAmountCents =
  // valor do título no momento do agendamento).
  const valueChanged = input.amountCents !== payable.amountCents;
  if (valueChanged) {
    const payments = await ctx.repos.payments.listByPayable(ctx.companyId, payable.id);
    const reserving = payments.some(
      (p) => p.status === "pending_approval" || p.status === "approved"
    );
    if (reserving) {
      throw new ValidationError(
        `O valor do título ${payable.id} não pode ser alterado enquanto houver pagamento pendente ou aprovado (a alçada de aprovação foi calculada sobre o valor atual). Cancele o agendamento para alterar o valor.`
      );
    }
  }

  const nowIso = ctx.clock.now().toISOString();
  const before = { ...payable };

  // Aplica apenas os campos editáveis; supplierId/documentId/parcela/originKey
  // permanecem intactos. Campos opcionais com null limpam; undefined mantém.
  const applyOptional = <T>(incoming: T | null | undefined, current: T | undefined): T | undefined =>
    incoming === undefined ? current : incoming ?? undefined;

  payable.description = input.description;
  payable.issueDate = input.issueDate;
  payable.dueDate = input.dueDate;
  payable.amountCents = input.amountCents;
  payable.categoryId = applyOptional(input.categoryId, payable.categoryId);
  payable.costCenterId = applyOptional(input.costCenterId, payable.costCenterId);
  payable.supplierCategory = applyOptional(input.supplierCategory, payable.supplierCategory);
  payable.costClassification = applyOptional(input.costClassification, payable.costClassification);
  payable.notes = applyOptional(input.notes, payable.notes);
  payable.updatedAt = nowIso;

  await ctx.repos.payables.update(payable);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payable.updated",
    entityType: "payable",
    entityId: payable.id,
    before,
    after: payable,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payable.updated",
    payload: { id: payable.id, amountCents: payable.amountCents, dueDate: payable.dueDate },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    { payable },
    {
      assumptions: [
        "Edição registrada na trilha de auditoria (payable.updated) com estado anterior e novo. Fornecedor, documento e parcela não são editáveis (preservam a chave de idempotência).",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

/**
 * CORREÇÃO DA DATA DE PAGAMENTO de um pagamento já conciliado.
 *
 * A data informada na conciliação é a que decide a situação do título: "Pago"
 * (antes do vencimento), "Pago no Vencimento" (no dia) ou "Pago Atrasado"
 * (depois). Digitada errada, não havia como corrigir — `reconcile_payment` é
 * idempotente e volta sem efeito num pagamento já executado.
 *
 * Repete as validações que a conciliação faz sobre essa mesma data: nada de
 * futuro (conciliar é confirmar fato ocorrido) e nada antes da emissão do
 * título. Não toca em valor, saldo, status do pagamento nem do título.
 *
 * O lançamento contábil NÃO é ajustado aqui: quem realinha é o passo seguinte
 * do fluxo (`restate_entries` na skill contábil), porque a regra de quando
 * corrigir e quando estornar é dela.
 */
async function adjustPaymentDate(
  ctx: SkillContext,
  input: AdjustPaymentDateInput
): Promise<SkillResult<AdjustPaymentDateData>> {
  if (ctx.actor.type === "user") {
    if (!ctx.actor.role || !hasPermission(ctx.actor.role, "payment.execute")) {
      throw new PermissionError(
        `Usuário ${ctx.actor.id} (papel ${ctx.actor.role ?? "nenhum"}) não pode corrigir a data de pagamentos.`
      );
    }
  }

  const payment = await ctx.repos.payments.getById(ctx.companyId, input.paymentId);
  if (!payment) throw new NotFoundError("Pagamento", input.paymentId);
  const payable = await ctx.repos.payables.getById(ctx.companyId, payment.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", payment.payableId);

  if (payment.status !== "executed") {
    throw new ValidationError(
      `Pagamento ${payment.id} não está conciliado (status atual: ${payment.status}); não há data de pagamento para corrigir.`
    );
  }
  if (input.paymentDate > ctx.today()) {
    throw new ValidationError(
      `Data do pagamento (${formatBR(input.paymentDate)}) está no futuro; informe a data em que o pagamento realmente saiu.`
    );
  }
  if (input.paymentDate < payable.issueDate) {
    throw new ValidationError(
      `Data do pagamento (${formatBR(input.paymentDate)}) é anterior à emissão do título (${formatBR(payable.issueDate)}).`
    );
  }

  // A data corrente vem do executedAt gravado ao meio-dia UTC pela conciliação:
  // os 10 primeiros caracteres são a data informada, sem risco de fuso.
  const atual = (payment.executedAt ?? "").slice(0, 10);
  if (atual === input.paymentDate) {
    return makeResult(
      SKILL,
      ctx,
      { payment, payable },
      {
        assumptions: ["Data informada é igual à atual; nada foi alterado."],
        dataSources: DATA_SOURCES,
      }
    );
  }

  const before = { ...payment };
  // Meio-dia UTC, como na conciliação: converter para o fuso da empresa nunca
  // muda o dia informado.
  payment.executedAt = toUtcNoon(input.paymentDate).toISOString();
  payment.updatedAt = ctx.clock.now().toISOString();
  await ctx.repos.payments.update(payment);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payment.date_adjusted",
    entityType: "payment",
    entityId: payment.id,
    before,
    after: payment,
    correlationId: ctx.correlationId,
  });
  // A situação do título é derivada desta data; avisar que ele mudou de leitura.
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payable.updated",
    payload: { id: payable.id, paidAt: input.paymentDate },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  const emAtraso = input.paymentDate > payable.dueDate;
  return makeResult(
    SKILL,
    ctx,
    { payment, payable },
    {
      assumptions: [
        `Data do pagamento corrigida de ${formatBR(atual)} para ${formatBR(input.paymentDate)}. Valor, baixa e status do título não mudam.`,
        `Situação do título passa a ser "${
          emAtraso
            ? "Pago Atrasado"
            : input.paymentDate === payable.dueDate
              ? "Pago no Vencimento"
              : "Pago"
        }" (vencimento ${formatBR(payable.dueDate)}).`,
        "O realizado do Orçamento acompanha a nova data e pode mudar de mês.",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

/**
 * CONCILIAÇÃO de um pagamento aprovado: registra a data em que o dinheiro saiu
 * do banco e baixa o título, que volta para Contas a pagar já quitado.
 *
 * É o passo que a aprovação deixou de fazer. A `paymentDate` informada vira o
 * `executedAt` do pagamento — e é ela, comparada ao vencimento, que faz a tela
 * de Contas a pagar mostrar "Pago" (em dia) ou "Pago Atrasado". Por isso a data
 * é gravada ao MEIO-DIA UTC (`toUtcNoon`): assim a conversão para o fuso da
 * empresa nunca cai no dia anterior nem no seguinte.
 *
 * Só pagamento `approved` é conciliável — pendente ainda não foi decidido,
 * executado já foi conciliado, e rejeitado/cancelado não tem o que baixar.
 */
async function reconcilePayment(
  ctx: SkillContext,
  input: ReconcilePaymentInput
): Promise<SkillResult<ReconcilePaymentData>> {
  if (ctx.actor.type === "user") {
    if (!ctx.actor.role || !hasPermission(ctx.actor.role, "payment.execute")) {
      throw new PermissionError(
        `Usuário ${ctx.actor.id} (papel ${ctx.actor.role ?? "nenhum"}) não pode conciliar pagamentos.`
      );
    }
  }

  const payment = await ctx.repos.payments.getById(ctx.companyId, input.paymentId);
  if (!payment) throw new NotFoundError("Pagamento", input.paymentId);
  const payable = await ctx.repos.payables.getById(ctx.companyId, payment.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", payment.payableId);

  // Idempotência: reenviar o formulário não baixa o título duas vezes.
  if (payment.status === "executed") {
    return makeResult(
      SKILL,
      ctx,
      { payment, payable },
      {
        assumptions: ["Pagamento já estava conciliado; nenhuma alteração adicional foi feita."],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (payment.status !== "approved") {
    throw new ValidationError(
      `Pagamento ${payment.id} não está aprovado (status atual: ${payment.status}) e não pode ser conciliado.`
    );
  }

  // Data futura não concilia: conciliar é confirmar um fato já ocorrido.
  const today = ctx.today();
  if (input.paymentDate > today) {
    throw new ValidationError(
      `Data do pagamento (${formatBR(input.paymentDate)}) está no futuro; informe a data em que o pagamento realmente saiu.`
    );
  }
  if (input.paymentDate < payable.issueDate) {
    throw new ValidationError(
      `Data do pagamento (${formatBR(input.paymentDate)}) é anterior à emissão do título (${formatBR(payable.issueDate)}).`
    );
  }

  // Revalida o saldo no momento da baixa: outro pagamento pode ter sido
  // conciliado entre a aprovação e agora.
  if (payment.amountCents > payableRemainingCents(payable)) {
    throw new ValidationError(
      `Pagamento ${payment.id} (${formatBRL(payment.amountCents)}) excede o saldo restante ` +
        `do título ${payable.id} (${formatBRL(payableRemainingCents(payable))}) no momento da conciliação.`
    );
  }

  const nowIso = ctx.clock.now().toISOString();
  const paymentBefore = { ...payment };
  const payableBefore = { ...payable };

  payment.status = "executed";
  payment.executedAt = toUtcNoon(input.paymentDate).toISOString();
  payment.executedBy = ctx.actor.id;
  payment.updatedAt = nowIso;

  payable.paidCents += payment.amountCents;
  payable.status = payable.paidCents >= payable.amountCents ? "paid" : "partially_paid";
  payable.updatedAt = nowIso;

  // Atômico: baixa do pagamento e do título commitam juntos — um crash entre os
  // dois não deixa pagamento executado com título em aberto.
  await ctx.repos.withTransaction(async (tx) => {
    await tx.payments.update(payment);
    await tx.payables.update(payable);
  });

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payment.executed",
    entityType: "payment",
    entityId: payment.id,
    before: paymentBefore,
    after: payment,
    correlationId: ctx.correlationId,
  });
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payable.updated",
    entityType: "payable",
    entityId: payable.id,
    before: payableBefore,
    after: payable,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payment.executed",
    payload: {
      id: payment.id,
      payableId: payable.id,
      amountCents: payment.amountCents,
      executedBy: payment.executedBy,
      paymentDate: input.paymentDate,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payable.updated",
    payload: { id: payable.id, status: payable.status, paidCents: payable.paidCents },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  const emAtraso = input.paymentDate > payable.dueDate;
  return makeResult(
    SKILL,
    ctx,
    { payment, payable },
    {
      assumptions: [
        `Pagamento conciliado em ${formatBR(input.paymentDate)} (execução em ambiente MOCK: nenhuma ordem bancária real foi emitida).`,
        `Título ${payable.id} devolvido para Contas a pagar como "${payable.status}"` +
          (payable.status === "paid"
            ? emAtraso
              ? ` — pago APÓS o vencimento (${formatBR(payable.dueDate)}): situação "Pago Atrasado".`
              : ` — pago até o vencimento (${formatBR(payable.dueDate)}): situação "Pago".`
            : " (baixa parcial; saldo continua em aberto)."),
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

/**
 * ESTORNO de pagamento executado. Desfaz a baixa e devolve o título para Contas
 * a pagar — é a volta atrás de uma aprovação que já produziu efeito.
 *
 * Exige `payment.execute` (a mesma permissão de executar o pagamento): desfazer
 * uma baixa pesa tanto quanto fazê-la. Só pagamento `executed` é estornável;
 * pendente/aprovado se cancela pelo título, e rejeitado nunca teve efeito.
 *
 * Nada é apagado: o pagamento vai para `canceled` (some das visões de caixa,
 * orçamento e contabilidade, que filtram por status) e a trilha guarda o
 * antes/depois com o motivo. `executedAt`/`executedBy` permanecem no registro —
 * são o histórico de que houve execução, e nenhuma consulta os lê sem antes
 * filtrar o status.
 *
 * O título volta para: `open` quando não sobra baixa nenhuma; `partially_paid`
 * se outro pagamento executado ainda o baixa em parte; `scheduled` quando resta
 * outro pagamento aguardando aprovação. Nos três casos ele reaparece em Contas
 * a pagar (os três são status "em aberto" da tela).
 */
async function reversePayment(
  ctx: SkillContext,
  input: ReversePaymentInput
): Promise<SkillResult<ReversePaymentData>> {
  if (ctx.actor.type === "user") {
    if (!ctx.actor.role || !hasPermission(ctx.actor.role, "payment.execute")) {
      throw new PermissionError(
        `Usuário ${ctx.actor.id} (papel ${ctx.actor.role ?? "nenhum"}) não pode estornar pagamentos.`
      );
    }
  }

  const payment = await ctx.repos.payments.getById(ctx.companyId, input.paymentId);
  if (!payment) throw new NotFoundError("Pagamento", input.paymentId);
  const payable = await ctx.repos.payables.getById(ctx.companyId, payment.payableId);
  if (!payable) throw new NotFoundError("Título a pagar", payment.payableId);

  // Idempotência: estorno repetido (duplo clique, reenvio do formulário) não
  // devolve o valor duas vezes.
  if (payment.status === "canceled") {
    return makeResult(
      SKILL,
      ctx,
      { payment, payable, reason: input.reason },
      {
        assumptions: ["Pagamento já estava estornado; nenhuma alteração adicional foi feita."],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (payment.status !== "executed") {
    throw new ValidationError(
      `Pagamento ${payment.id} não está executado (status atual: ${payment.status}) e não pode ser estornado.`
    );
  }
  if (payable.status === "canceled") {
    throw new ValidationError(
      `Título ${payable.id} está cancelado; não é possível devolvê-lo para Contas a pagar pelo estorno.`
    );
  }

  // Outro pagamento ainda reservando o título mantém a situação "agendado"
  // depois do estorno — o título volta para a lista, mas não como livre.
  const siblings = await ctx.repos.payments.listByPayable(ctx.companyId, payable.id);
  const stillReserved = siblings.some(
    (p) => p.id !== payment.id && (p.status === "pending_approval" || p.status === "approved")
  );

  const nowIso = ctx.clock.now().toISOString();
  const paymentBefore = { ...payment };
  const payableBefore = { ...payable };

  payment.status = "canceled";
  payment.updatedAt = nowIso;

  // Math.max protege contra paidCents negativo se a baixa tiver sido desfeita
  // por outro caminho (conciliação) entre a leitura e a escrita.
  payable.paidCents = Math.max(0, payable.paidCents - payment.amountCents);
  payable.status =
    payable.paidCents > 0 ? "partially_paid" : stillReserved ? "scheduled" : "open";
  payable.updatedAt = nowIso;

  // Atômico, como na execução: estorno do pagamento e devolução do saldo do
  // título commitam juntos — um crash no meio não deixa título baixado sem
  // pagamento correspondente.
  await ctx.repos.withTransaction(async (tx) => {
    await tx.payments.update(payment);
    await tx.payables.update(payable);
  });

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payment.reversed",
    entityType: "payment",
    entityId: payment.id,
    before: paymentBefore,
    after: { ...payment, reverseReason: input.reason },
    correlationId: ctx.correlationId,
  });
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "payable.updated",
    entityType: "payable",
    entityId: payable.id,
    before: payableBefore,
    after: payable,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "payment.reversed",
    payload: {
      id: payment.id,
      payableId: payable.id,
      amountCents: payment.amountCents,
      reason: input.reason,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  // Marca a aprovação que autorizou este pagamento como ESTORNADA. A tela de
  // Aprovações deixa de listá-la no histórico, mas o registro permanece: é a
  // única cópia de quem aprovou (approverIds/decidedBy/justification) e
  // Controles Internos exige encontrá-lo (regra approval_exists). Apagar a
  // linha deixaria Payment.approvalId e FlowRun.approvalId órfãos.
  const approvalNota: string[] = [];
  if (payment.approvalId) {
    const approval = await ctx.repos.approvals.getById(ctx.companyId, payment.approvalId);
    if (approval && !approval.revertedAt) {
      const approvalBefore = { ...approval };
      approval.revertedAt = nowIso;
      await ctx.repos.approvals.update(approval);
      await ctx.audit.record(ctx.companyId, {
        actor: ctx.actor,
        action: "approval.reverted",
        entityType: "approval",
        entityId: approval.id,
        before: approvalBefore,
        after: { ...approval, reverseReason: input.reason },
        correlationId: ctx.correlationId,
      });
      approvalNota.push(
        `Aprovação ${approval.id} marcada como estornada: sai do histórico de decisões, mas segue registrada para auditoria e controles internos.`
      );
    }

    // LIBERA a chave de idempotência do agendamento que originou este pagamento.
    // Sem isto, o título volta para Contas a pagar mas um novo "Pagar" com os
    // MESMOS parâmetros (mesma conta, mesma data) bate no fluxo concluído e é
    // devolvido do cache: nada é criado e nenhuma aprovação aparece. É a mesma
    // armadilha da rejeição, pelo caminho do estorno — e a regra do orquestrador
    // não pega, porque ela só descarta fluxo rejeitado ou falho, e este ficou
    // "concluído". Estornar é justamente o desfecho que devolve o título à fila.
    const flowRun =
      (approval?.flowRunId
        ? await ctx.repos.flowRuns.getById(ctx.companyId, approval.flowRunId)
        : null) ?? (await ctx.repos.flowRuns.findByApprovalId(ctx.companyId, payment.approvalId));
    if (flowRun) {
      await ctx.repos.idempotency.remove(ctx.companyId, flowRun.idempotencyKey);
      approvalNota.push(
        "O título pode ser reenviado para pagamento com os mesmos dados (conta e data) — a solicitação anterior deixou de bloquear."
      );
    }
  }

  return makeResult(
    SKILL,
    ctx,
    { payment, payable, reason: input.reason },
    {
      assumptions: [
        `Pagamento ${payment.id} estornado (${formatBRL(payment.amountCents)}); título ${payable.id} devolvido para Contas a pagar com situação "${payable.status}".`,
        "O pagamento fica como cancelado e sai das visões de caixa, orçamento e contabilidade; a trilha de auditoria preserva a execução anterior.",
        ...approvalNota,
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

/**
 * Gera os títulos a pagar recorrentes devidos no mês corrente. Para cada
 * template ativo (kind=payable) cuja janela inclui o mês de hoje, cria o título
 * do mês reaproveitando createPayable — idempotente por originKey (que inclui o
 * vencimento do mês), então rodar de novo no mesmo mês não duplica.
 */
async function generateRecurring(
  ctx: SkillContext
): Promise<SkillResult<GenerateRecurringData>> {
  const today = ctx.today();
  const templates = await ctx.repos.recurringTemplates.listActive(ctx.companyId);
  const generated: GenerateRecurringData["generated"] = [];

  for (const t of templates) {
    if (t.kind !== "payable") continue; // Contas a Receber vem em etapa posterior.
    const month = shouldGenerateFor(t, today);
    if (!month) continue;

    const dueDate = dueDateForMonth(t, month);
    // createPayable é idempotente por originKey; para saber se o título é NOVO
    // (e não um replay do mesmo mês), comparamos a contagem antes/depois.
    const before = (await ctx.repos.payables.listAll(ctx.companyId)).length;
    const result = await createPayable(ctx, {
      action: "create_payable",
      supplierId: t.counterpartyId,
      description: `${t.description} (recorrência ${month})`,
      issueDate: dueDate,
      dueDate,
      amountCents: t.amountCents,
      supplierCategory: t.category,
      costClassification: t.costClassification,
      installmentCount: 1,
    });
    const after = (await ctx.repos.payables.listAll(ctx.companyId)).length;
    const payable = (result.data as CreatePayableData | undefined)?.payables?.[0];
    if (payable && after > before) {
      generated.push({ templateId: t.id, payableId: payable.id, dueDate });
    }
  }

  return makeResult(SKILL, ctx, { generated }, { dataSources: DATA_SOURCES });
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const contasAPagarSkill: SkillDefinition<ContasAPagarInput, ContasAPagarData> = {
  name: SKILL,
  responsibility:
    "Cadastro e classificação de obrigações a pagar; vencimentos, parcelas, juros e multas; aprovação de pagamentos por alçada; alertas de vencimento; previsão de desembolsos; detecção de duplicidade.",
  objective:
    "Garantir que nenhuma obrigação seja perdida, duplicada ou paga sem aprovação humana, com visibilidade completa dos desembolsos futuros.",
  inputSchema: contasAPagarInputSchema,
  consumes: [],
  publishes: [
    "payable.created",
    "payable.updated",
    "payable.canceled",
    "payment.scheduled",
    "payment.approved",
    "payment.executed",
    "payment.reversed",
  ],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "create_payable":
        return createPayable(ctx, input);
      case "schedule_payment":
        return schedulePayment(ctx, input);
      case "list_due":
        return listDue(ctx, input);
      case "forecast_disbursements":
        return forecastDisbursements(ctx, input);
      case "detect_duplicates":
        return detectDuplicates(ctx);
      case "cancel_payable":
        return cancelPayable(ctx, input);
      case "update_payable":
        return updatePayable(ctx, input);
      case "adjust_payment_date":
        return adjustPaymentDate(ctx, input);
      case "reconcile_payment":
        return reconcilePayment(ctx, input);
      case "reverse_payment":
        return reversePayment(ctx, input);
      case "generate_recurring":
        return generateRecurring(ctx);
    }
  },
};
