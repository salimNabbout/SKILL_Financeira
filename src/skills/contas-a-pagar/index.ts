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
import { addDays, addMonths, diffDays, isISODate, minDate, type ISODate } from "@/core/dates";
import type { FinancialDocument, Payable, Payment } from "@/core/entities";
import { dueDateForMonth, shouldGenerateFor } from "@/core/recurrence";
import { NotFoundError, PermissionError, ValidationError } from "@/core/errors";
import { hashPayload } from "@/core/ids";
import { computeLateFee, formatBRL, splitInstallments, type CurrencyCode } from "@/core/money";
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

const createPayableSchema = z.object({
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
  notes: z.string().optional(),
  document: documentSchema.optional(),
});

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

const generateRecurringSchema = z.object({
  action: z.literal("generate_recurring"),
});

export const contasAPagarInputSchema = z.discriminatedUnion("action", [
  createPayableSchema,
  schedulePaymentSchema,
  listDueSchema,
  forecastDisbursementsSchema,
  detectDuplicatesSchema,
  cancelPayableSchema,
  generateRecurringSchema,
]);

export type CreatePayableInput = z.infer<typeof createPayableSchema>;
export type SchedulePaymentInput = z.infer<typeof schedulePaymentSchema>;
export type ListDueInput = z.infer<typeof listDueSchema>;
export type ForecastDisbursementsInput = z.infer<typeof forecastDisbursementsSchema>;
export type DetectDuplicatesInput = z.infer<typeof detectDuplicatesSchema>;
export type CancelPayableInput = z.infer<typeof cancelPayableSchema>;
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
  | GenerateRecurringData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_STATUSES: Payable["status"][] = ["open", "partially_paid", "scheduled"];

function remainingCents(p: Payable): number {
  return p.amountCents - p.paidCents;
}

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

  const supplier = await ctx.repos.suppliers.getById(ctx.companyId, input.supplierId);
  if (!supplier) throw new NotFoundError("Fornecedor", input.supplierId);
  if (!supplier.active) {
    throw new ValidationError(`Fornecedor inativo: ${supplier.name} (${supplier.id}).`);
  }
  if (input.dueDate < input.issueDate) {
    throw new ValidationError(
      `Vencimento (${input.dueDate}) não pode ser anterior à emissão (${input.issueDate}).`
    );
  }
  if (input.categoryId) {
    const category = await ctx.repos.categories.getById(ctx.companyId, input.categoryId);
    if (!category) throw new NotFoundError("Categoria", input.categoryId);
  }
  if (input.costCenterId) {
    const costCenter = await ctx.repos.costCenters.getById(ctx.companyId, input.costCenterId);
    if (!costCenter) throw new NotFoundError("Centro de custo", input.costCenterId);
  }

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

  const installmentCount = input.installmentCount ?? 1;
  const amounts = splitInstallments(input.amountCents, installmentCount);
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

  const payables: Payable[] = [];
  for (let i = 0; i < installmentCount; i++) {
    const n = i + 1;
    const originKey = `${input.supplierId}:${documentRef}:${n}/${installmentCount}`;
    const existing = await ctx.repos.payables.findByOriginKey(ctx.companyId, originKey);
    if (existing) {
      // Idempotência: repetir a mesma entrada não duplica títulos.
      payables.push(existing);
      assumptions.push(
        `Parcela ${n}/${installmentCount} já cadastrada (originKey "${originKey}"); título existente ${existing.id} reutilizado sem criar duplicata.`
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
    const payable: Payable = {
      id: ctx.ids.next("payb"),
      companyId: ctx.companyId,
      supplierId: input.supplierId,
      documentId: document?.id,
      description:
        installmentCount > 1
          ? `${input.description} (parcela ${n}/${installmentCount})`
          : input.description,
      issueDate: input.issueDate,
      dueDate: addMonths(input.dueDate, i),
      amountCents: amounts[i],
      paidCents: 0,
      currency,
      status: "open",
      categoryId,
      costCenterId: input.costCenterId,
      supplierCategory: input.supplierCategory,
      costClassification: input.costClassification,
      installmentNumber: n,
      installmentCount,
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
      formula: `parcelas = splitInstallments(${input.amountCents}, ${installmentCount}); vencimento da parcela n = dueDate + (n-1) mês; soma das parcelas = total exato`,
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
  const available = remainingCents(payable) - reservedCents;
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

  // Idempotência da retomada: decisão já aplicada não gera novo efeito.
  if (decision.status === "approved" && payment.status === "executed") {
    return makeResult(
      SKILL,
      ctx,
      { payment },
      {
        assumptions: ["Pagamento já havia sido executado; retomada idempotente sem novo efeito."],
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
    // Segregação de funções também na skill (defesa em profundidade).
    assertSegregation(payment.requestedBy, decision.decidedBy);

    // Revalida o saldo no momento da execução: se outro pagamento foi executado
    // entre o agendamento e esta aprovação, este pagamento não pode sobre-baixar.
    if (payment.amountCents > remainingCents(payable)) {
      throw new ValidationError(
        `Pagamento ${payment.id} (${formatBRL(payment.amountCents)}) excede o saldo restante ` +
          `do título ${payable.id} (${formatBRL(remainingCents(payable))}) no momento da execução.`
      );
    }

    payment.status = "executed";
    payment.executedAt = nowIso;
    payment.executedBy = decision.decidedBy;
    payment.approvalId = decision.id;
    payment.updatedAt = nowIso;

    payable.paidCents += payment.amountCents;
    payable.status = payable.paidCents >= payable.amountCents ? "paid" : "partially_paid";
    payable.updatedAt = nowIso;

    // Atômico: pagamento executado e título baixado commitam juntos — um crash
    // entre os dois não deixa mais o pagamento "executed" com o título em aberto.
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

    return makeResult(
      SKILL,
      ctx,
      { payment },
      {
        assumptions: [
          `Pagamento aprovado por ${decision.decidedBy} e executado em ambiente MOCK: nenhuma ordem bancária real foi emitida.`,
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
    const remaining = remainingCents(p);
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
    weekly[weekIndex].totalCents += remainingCents(p);
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
    "payment.executed",
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
      case "generate_recurring":
        return generateRecurring(ctx);
    }
  },
};
