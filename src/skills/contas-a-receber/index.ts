/**
 * Skill: Contas a Receber
 * Clientes, títulos e parcelas; vencimentos e recebimentos; atrasos; projeção
 * de entradas; baixa manual. Integração Pix/boleto/cartão é CONCEITUAL
 * (campo `method` apenas — nenhuma integração real no MVP).
 *
 * A skill nunca movimenta dinheiro: registra recebimentos já ocorridos e
 * recomenda ações; cobranças/envios são responsabilidade de outras skills.
 */

import { z } from "zod";
import { addDays, addMonths, diffDays, formatBR, minDate, type ISODate } from "@/core/dates";
import type { CurrencyCode, LateFeeResult } from "@/core/money";
import {
  computeLateFee,
  formatBRL,
  receivableRemainingCents,
  splitInstallments,
} from "@/core/money";
import type { Receipt, Receivable } from "@/core/entities";
import { dueDateForMonth, shouldGenerateFor } from "@/core/recurrence";
import type { ChargeResult } from "@/core/integrations";
import { hashPayload } from "@/core/ids";
import { ValidationError } from "@/core/errors";
import { errorResult, makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL_NAME = "contas_a_receber" as const;

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD");

const centsSchema = z.number().int().positive();

const receiptMethodSchema = z.enum(["pix", "boleto", "card", "transfer", "cash"]);

const createReceivableSchema = z.object({
  action: z.literal("create_receivable"),
  customerId: z.string().min(1),
  description: z.string().min(1),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  amountCents: centsSchema,
  categoryId: z.string().min(1).optional(),
  costCenterId: z.string().min(1).optional(),
  installmentCount: z.number().int().min(1).max(120).optional(),
  method: receiptMethodSchema.optional(),
  notes: z.string().optional(),
});

const createFromInvoiceSchema = z.object({
  action: z.literal("create_from_invoice"),
  invoiceId: z.string().min(1),
  installments: z
    .array(z.object({ dueDate: isoDateSchema, amountCents: centsSchema }))
    .min(1)
    .optional(),
  method: receiptMethodSchema.optional(),
});

const listOverdueSchema = z.object({
  action: z.literal("list_overdue"),
});

const registerReceiptSchema = z.object({
  action: z.literal("register_receipt"),
  receivableId: z.string().min(1),
  amountCents: centsSchema,
  receivedDate: isoDateSchema,
  method: receiptMethodSchema,
  bankAccountId: z.string().min(1).optional(),
});

const projectionSchema = z.object({
  action: z.literal("projection"),
  horizonDays: z.number().int().min(1).max(365).optional(),
});

const issueChargeSchema = z.object({
  action: z.literal("issue_charge"),
  receivableId: z.string().min(1),
  kind: z.enum(["pix", "boleto"]),
});

const generateRecurringSchema = z.object({
  action: z.literal("generate_recurring"),
});

export const contasAReceberInputSchema = z.discriminatedUnion("action", [
  createReceivableSchema,
  createFromInvoiceSchema,
  listOverdueSchema,
  registerReceiptSchema,
  projectionSchema,
  issueChargeSchema,
  generateRecurringSchema,
]);

export type ContasAReceberInput = z.infer<typeof contasAReceberInputSchema>;
export type IssueChargeInput = z.infer<typeof issueChargeSchema>;
export type CreateReceivableInput = z.infer<typeof createReceivableSchema>;
export type CreateFromInvoiceInput = z.infer<typeof createFromInvoiceSchema>;
export type ListOverdueInput = z.infer<typeof listOverdueSchema>;
export type RegisterReceiptInput = z.infer<typeof registerReceiptSchema>;
export type ProjectionInput = z.infer<typeof projectionSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface CreateReceivableData {
  receivables: Receivable[];
  formula: string;
}

export interface OverdueItem {
  receivable: Receivable;
  daysLate: number;
  remainingCents: number;
  lateFee: LateFeeResult;
}

export interface ListOverdueData {
  overdue: OverdueItem[];
  totalOverdueCents: number;
  totalWithLateFeesCents: number;
  count: number;
  formula: string;
  period: { until: ISODate };
}

export interface RegisterReceiptData {
  receipt: Receipt;
  receivable: Receivable;
  remainingCents: number;
  /** Parte do recebimento aplicada ao principal do título (nunca excede o saldo). */
  principalCents: number;
  /**
   * Excedente sobre o saldo reconhecido como encargo financeiro (multa+juros).
   * Zero quando o recebimento não ultrapassa o saldo do título.
   */
  chargesCents: number;
  formula: string;
}

export interface ProjectionWeek {
  week: number;
  weekStart: ISODate;
  weekEnd: ISODate;
  expectedCents: number;
  count: number;
}

export interface ProjectionData {
  horizonDays: number;
  weekly: ProjectionWeek[];
  totalCents: number;
  formula: string;
  period: { start: ISODate; end: ISODate };
}

export interface IssueChargeData {
  charge: ChargeResult;
  receivable: Receivable;
  remainingCents: number;
}

export interface GenerateRecurringData {
  /** Títulos a receber criados nesta rodada. */
  generated: Array<{ templateId: string; receivableId: string; dueDate: string }>;
}

export type ContasAReceberData =
  | CreateReceivableData
  | ListOverdueData
  | RegisterReceiptData
  | ProjectionData
  | IssueChargeData
  | GenerateRecurringData
  | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currencyOf(ctx: SkillContext): CurrencyCode {
  // MVP opera em BRL; o cast é seguro pois CompanyConfig.currency armazena um CurrencyCode.
  return (ctx.config.currency as CurrencyCode) || "BRL";
}

interface InstallmentPlanItem {
  dueDate: ISODate;
  amountCents: number;
}

interface CreatePlanParams {
  customerId: string;
  invoiceId?: string;
  description: string;
  issueDate: ISODate;
  plan: InstallmentPlanItem[];
  originKeyFor: (installmentNumber: number, total: number) => string;
  method?: Receivable["method"];
  categoryId?: string;
  costCenterId?: string;
  notes?: string;
}

/**
 * Cria os títulos do plano de parcelas de forma idempotente por originKey:
 * parcelas já existentes são reutilizadas (nunca duplicadas) e contabilizadas.
 */
async function createInstallments(
  ctx: SkillContext,
  params: CreatePlanParams
): Promise<{ receivables: Receivable[]; reused: number }> {
  const total = params.plan.length;
  const receivables: Receivable[] = [];
  let reused = 0;

  for (let i = 0; i < total; i += 1) {
    const item = params.plan[i];
    const originKey = params.originKeyFor(i + 1, total);
    const existing = await ctx.repos.receivables.findByOriginKey(ctx.companyId, originKey);
    if (existing) {
      receivables.push(existing);
      reused += 1;
      continue;
    }

    const now = ctx.clock.now().toISOString();
    const receivable: Receivable = {
      id: ctx.ids.next("rcv"),
      companyId: ctx.companyId,
      customerId: params.customerId,
      invoiceId: params.invoiceId,
      description:
        total > 1 ? `${params.description} (parcela ${i + 1}/${total})` : params.description,
      issueDate: params.issueDate,
      dueDate: item.dueDate,
      amountCents: item.amountCents,
      receivedCents: 0,
      currency: currencyOf(ctx),
      status: "open",
      method: params.method,
      categoryId: params.categoryId,
      costCenterId: params.costCenterId,
      installmentNumber: i + 1,
      installmentCount: total,
      originKey,
      notes: params.notes,
      createdBy: ctx.actor.id,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.repos.receivables.create(receivable);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "receivable.created",
      entityType: "receivable",
      entityId: receivable.id,
      after: receivable,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "receivable.created",
      payload: {
        receivableId: receivable.id,
        customerId: receivable.customerId,
        invoiceId: receivable.invoiceId,
        amountCents: receivable.amountCents,
        dueDate: receivable.dueDate,
        installment: `${i + 1}/${total}`,
      },
      source: SKILL_NAME,
      correlationId: ctx.correlationId,
    });
    receivables.push(receivable);
  }

  return { receivables, reused };
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function createReceivable(
  ctx: SkillContext,
  input: CreateReceivableInput
): Promise<SkillResult<ContasAReceberData>> {
  const customer = await ctx.repos.customers.getById(ctx.companyId, input.customerId);
  if (!customer) {
    return errorResult(SKILL_NAME, ctx, "customer_not_found", `Cliente não encontrado: ${input.customerId}`);
  }
  if (!customer.active) {
    return errorResult(SKILL_NAME, ctx, "customer_inactive", `Cliente inativo: ${customer.name}. Reative o cadastro antes de criar títulos.`);
  }
  // Vencimento não pode anteceder a emissão (paridade com contas a pagar).
  if (input.dueDate < input.issueDate) {
    // Mensagem amigável (datas em pt-BR, nunca ISO); mesmo code invalid_dates.
    return errorResult(
      SKILL_NAME,
      ctx,
      "invalid_dates",
      `Verificar a Data da Emissão (vencimento ${formatBR(input.dueDate)} é anterior à emissão ${formatBR(input.issueDate)}).`
    );
  }

  const assumptions: string[] = [];
  const pendingItems: PendingItem[] = [];
  let confidence = 1.0;

  let categoryId = input.categoryId;
  if (categoryId) {
    const category = await ctx.repos.categories.getById(ctx.companyId, categoryId);
    if (!category) {
      return errorResult(SKILL_NAME, ctx, "category_not_found", `Categoria não encontrada: ${categoryId}`);
    }
  } else {
    // Mesmo padrão da AP: sugestão de categoria (IA/heurística) sobre categorias de receita.
    const candidates = (await ctx.repos.categories.listAll(ctx.companyId)).filter(
      (c) => c.kind === "income" && c.active
    );
    const suggestion = await ctx.ai.suggestCategory(
      input.description,
      candidates.map((c) => ({ id: c.id, name: c.name, kind: c.kind }))
    );
    if (suggestion.categoryId) {
      categoryId = suggestion.categoryId;
      confidence = Math.min(confidence, suggestion.confidence);
      assumptions.push(
        `Categoria sugerida automaticamente (provedor "${ctx.ai.provider}", confiança ${suggestion.confidence}): ${suggestion.rationale}`
      );
    } else {
      assumptions.push(
        "Nenhuma categoria informada e a sugestão automática não encontrou correspondência; títulos criados sem categoria."
      );
    }
  }

  // Sem installmentCount informado, o título é criado à vista (1 parcela).
  const count = input.installmentCount ?? 1;
  const parts = splitInstallments(input.amountCents, count);
  const shortHash = hashPayload({
    customerId: input.customerId,
    description: input.description,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    amountCents: input.amountCents,
    installmentCount: count,
  }).slice(0, 12);

  const plan: InstallmentPlanItem[] = parts.map((amountCents, i) => ({
    dueDate: i === 0 ? input.dueDate : addMonths(input.dueDate, i),
    amountCents,
  }));

  const { receivables, reused } = await createInstallments(ctx, {
    customerId: input.customerId,
    description: input.description,
    issueDate: input.issueDate,
    plan,
    originKeyFor: (n, total) => `${input.customerId}:${shortHash}:${n}/${total}`,
    method: input.method,
    categoryId,
    costCenterId: input.costCenterId,
    notes: input.notes,
  });

  if (reused > 0) {
    assumptions.push(
      `${reused} parcela(s) já existia(m) com a mesma chave de origem (originKey); os registros existentes foram retornados sem duplicação (idempotência).`
    );
  }

  const missingCategory = !categoryId;
  if (missingCategory) {
    for (const r of receivables) {
      pendingItems.push({
        code: "categoria_indefinida",
        description: `Título ${r.id} (${formatBRL(r.amountCents)}) sem categoria de receita.`,
        entityType: "receivable",
        entityId: r.id,
        suggestedAction: "Classificar manualmente a categoria de receita.",
      });
    }
  }

  const data: CreateReceivableData = {
    receivables,
    formula:
      "parcela_i = floor(total/n) + 1 centavo para as primeiras (total mod n) parcelas; soma das parcelas = valor total; vencimento_i = vencimento + (i-1) mês(es)",
  };

  return makeResult(SKILL_NAME, ctx, data as ContasAReceberData, {
    confidence,
    assumptions,
    pendingItems,
    dataSources: ["receivables", "customers", "categories"],
  });
}

async function createFromInvoice(
  ctx: SkillContext,
  input: CreateFromInvoiceInput
): Promise<SkillResult<ContasAReceberData>> {
  const invoice = await ctx.repos.invoices.getById(ctx.companyId, input.invoiceId);
  if (!invoice) {
    return errorResult(SKILL_NAME, ctx, "invoice_not_found", `Fatura não encontrada: ${input.invoiceId}`);
  }
  if (invoice.status !== "issued") {
    return errorResult(
      SKILL_NAME,
      ctx,
      "invoice_not_issued",
      `A fatura ${invoice.id} não está emitida (status atual: "${invoice.status}"); emita a fatura antes de gerar os títulos a receber.`
    );
  }

  const assumptions: string[] = [];
  let plan: InstallmentPlanItem[];

  if (!input.installments || input.installments.length === 0) {
    const dueDate = addDays(ctx.today(), 30);
    plan = [{ dueDate, amountCents: invoice.totalCents }];
    assumptions.push(
      `Plano de parcelas não informado: criada 1 parcela única de ${formatBRL(invoice.totalCents)} com vencimento em ${formatBR(dueDate)} (hoje + 30 dias).`
    );
  } else {
    const sum = input.installments.reduce((acc, p) => acc + p.amountCents, 0);
    if (sum !== invoice.totalCents) {
      return errorResult(
        SKILL_NAME,
        ctx,
        "installments_sum_mismatch",
        `A soma das parcelas (${formatBRL(sum)}) difere do total da fatura (${formatBRL(invoice.totalCents)}).`
      );
    }
    plan = input.installments.map((p) => ({ dueDate: p.dueDate, amountCents: p.amountCents }));
  }

  // Guarda de refaturamento: a idempotência por originKey é por parcela
  // (`inv:{invoiceId}:{n}/{total}`). Se a MESMA fatura for reprocessada com um
  // número de parcelas diferente, todas as chaves mudam e nenhum título ativo
  // pré-existente seria detectado — o que duplicaria o valor da fatura (cliente
  // cobrado em dobro). Antes de criar, verificamos se já existem títulos ATIVOS
  // (status != canceled) desta fatura; se existirem com plano diferente do
  // solicitado, rejeitamos. Com o MESMO plano, seguimos o fluxo idempotente.
  const originKeyFor = (n: number, total: number) => `inv:${invoice.id}:${n}/${total}`;
  const total = plan.length;
  const requestedOriginKeys = new Set(
    plan.map((_, i) => originKeyFor(i + 1, total))
  );
  const existingActive = (await ctx.repos.receivables.listByCustomer(ctx.companyId, invoice.customerId))
    .filter((r) => r.invoiceId === invoice.id && r.status !== "canceled");
  if (existingActive.length > 0) {
    const samePlan =
      existingActive.length === requestedOriginKeys.size &&
      existingActive.every((r) => requestedOriginKeys.has(r.originKey));
    if (!samePlan) {
      throw new ValidationError(
        `Fatura ${invoice.id} já possui ${existingActive.length} título(s) ativo(s) com plano de parcelas diferente do solicitado (${total} parcela(s)); cancele-os antes de refaturar para evitar duplicar a cobrança.`
      );
    }
  }

  const { receivables, reused } = await createInstallments(ctx, {
    customerId: invoice.customerId,
    invoiceId: invoice.id,
    description: invoice.description,
    issueDate: invoice.issueDate ?? ctx.today(),
    plan,
    originKeyFor,
    method: input.method,
  });

  if (reused > 0) {
    assumptions.push(
      `${reused} título(s) desta fatura já existia(m) (originKey "inv:${invoice.id}:..."); registros existentes retornados sem duplicação (idempotência).`
    );
  }

  const data: CreateReceivableData = {
    receivables,
    formula: "soma das parcelas = totalCents da fatura; sem parcelas informadas: 1 parcela = total, vencimento = hoje + 30 dias",
  };

  return makeResult(SKILL_NAME, ctx, data as ContasAReceberData, {
    assumptions,
    dataSources: ["receivables", "invoices", "customers"],
  });
}

async function listOverdue(ctx: SkillContext): Promise<SkillResult<ContasAReceberData>> {
  const today = ctx.today();
  const candidates = await ctx.repos.receivables.listByStatus(ctx.companyId, [
    "open",
    "partially_received",
  ]);
  const overdueReceivables = candidates
    .filter((r) => r.dueDate < today)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  const customers = await ctx.repos.customers.listAll(ctx.companyId);
  const customerNames = new Map(customers.map((c) => [c.id, c.name]));

  const overdue: OverdueItem[] = overdueReceivables.map((receivable) => {
    const daysLate = diffDays(receivable.dueDate, today);
    const remainingCents = receivableRemainingCents(receivable);
    const lateFee = computeLateFee(remainingCents, daysLate, ctx.config.lateFeeDefaults);
    return { receivable, daysLate, remainingCents, lateFee };
  });

  const totalOverdueCents = overdue.reduce((acc, o) => acc + o.remainingCents, 0);
  const totalWithLateFeesCents = overdue.reduce((acc, o) => acc + o.lateFee.totalCents, 0);
  const alerts: SkillAlert[] = [];

  if (overdue.length > 0) {
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "receivable.overdue_detected",
      payload: {
        count: overdue.length,
        totalOverdueCents,
        items: overdue.map((o) => ({
          receivableId: o.receivable.id,
          customerId: o.receivable.customerId,
          dueDate: o.receivable.dueDate,
          daysLate: o.daysLate,
          remainingCents: o.remainingCents,
          totalWithLateFeeCents: o.lateFee.totalCents,
        })),
      },
      source: SKILL_NAME,
      correlationId: ctx.correlationId,
    });

    const openAlerts = await ctx.repos.alerts.listOpen(ctx.companyId);
    for (const o of overdue) {
      const customerName = customerNames.get(o.receivable.customerId) ?? o.receivable.customerId;
      const message = `Título ${o.receivable.id} de ${customerName} vencido há ${o.daysLate} dia(s): saldo de ${formatBRL(o.remainingCents)} (vencimento ${formatBR(o.receivable.dueDate)}; com encargos: ${formatBRL(o.lateFee.totalCents)}).`;
      alerts.push({
        severity: "critical",
        code: "receivable_overdue",
        message,
        entityType: "receivable",
        entityId: o.receivable.id,
      });
      // Dedupe: não recria alerta aberto para o mesmo código + título.
      const alreadyOpen = openAlerts.some(
        (a) => a.code === "receivable_overdue" && a.entityId === o.receivable.id
      );
      if (alreadyOpen) continue;
      await ctx.repos.alerts.create({
        id: ctx.ids.next("alr"),
        companyId: ctx.companyId,
        severity: "critical",
        code: "receivable_overdue",
        message,
        entityType: "receivable",
        entityId: o.receivable.id,
        source: SKILL_NAME,
        status: "open",
        createdAt: ctx.clock.now().toISOString(),
      });
    }
  }

  const { finePercent, monthlyInterestPercent } = ctx.config.lateFeeDefaults;
  const data: ListOverdueData = {
    overdue,
    totalOverdueCents,
    totalWithLateFeesCents,
    count: overdue.length,
    formula: `saldo = valor - recebido; total_com_encargos = saldo + saldo×${finePercent}% + saldo×(${monthlyInterestPercent}%/30)×dias_atraso (política da empresa)`,
    period: { until: today },
  };

  return makeResult(SKILL_NAME, ctx, data as ContasAReceberData, {
    alerts,
    dataSources: ["receivables", "customers"],
  });
}

async function registerReceipt(
  ctx: SkillContext,
  input: RegisterReceiptInput
): Promise<SkillResult<ContasAReceberData>> {
  const receivable = await ctx.repos.receivables.getById(ctx.companyId, input.receivableId);
  if (!receivable) {
    return errorResult(SKILL_NAME, ctx, "receivable_not_found", `Título não encontrado: ${input.receivableId}`);
  }
  if (receivable.status === "canceled") {
    return errorResult(SKILL_NAME, ctx, "receivable_canceled", `O título ${receivable.id} está cancelado e não aceita recebimentos.`);
  }
  if (receivable.status === "received") {
    return errorResult(SKILL_NAME, ctx, "receivable_already_settled", `O título ${receivable.id} já está quitado.`);
  }

  const remainingBefore = receivableRemainingCents(receivable);
  const assumptions: string[] = [];

  // Decomposição principal vs. encargos:
  // - o principal aplicado ao título NUNCA excede o saldo (invariante do título);
  // - um recebimento ACIMA do saldo só é aceito quando o excedente corresponde
  //   aos encargos por atraso (multa+juros) calculados para o título na data do
  //   recebimento, com a política padrão da empresa (config.lateFeeDefaults) —
  //   a mesma régua que a cobrança usa (late.totalCents). Fora dessa correspondência
  //   (tolerância pequena de arredondamento), o excedente é rejeitado.
  const CHARGES_TOLERANCE_CENTS = 2; // absorve ruído de arredondamento do pró-rata
  let principalCents = input.amountCents;
  let chargesCents = 0;
  if (input.amountCents > remainingBefore) {
    const excessCents = input.amountCents - remainingBefore;
    const daysLate = Math.max(0, diffDays(receivable.dueDate, input.receivedDate));
    const late = computeLateFee(remainingBefore, daysLate, ctx.config.lateFeeDefaults);
    const expectedCharges = late.fineCents + late.interestCents;
    if (daysLate <= 0 || Math.abs(excessCents - expectedCharges) > CHARGES_TOLERANCE_CENTS) {
      return errorResult(
        SKILL_NAME,
        ctx,
        "receipt_exceeds_balance",
        `Recebimento de ${formatBRL(input.amountCents)} excede o saldo do título (${formatBRL(remainingBefore)})` +
          (daysLate > 0
            ? ` e o excedente de ${formatBRL(excessCents)} não corresponde aos encargos calculados (${formatBRL(expectedCharges)}: multa ${formatBRL(late.fineCents)} + juros ${formatBRL(late.interestCents)} por ${daysLate} dia(s) de atraso).`
            : ` (título não vencido na data do recebimento — sem encargos a reconhecer).`)
      );
    }
    // Excedente reconhecido como encargo: baixa o principal até o saldo e
    // registra o excedente (multa+juros) como receita financeira.
    principalCents = remainingBefore;
    chargesCents = excessCents;
    assumptions.push(
      `Recebimento de ${formatBRL(input.amountCents)} decomposto: ${formatBRL(principalCents)} de principal (quita o saldo do título) + ${formatBRL(chargesCents)} de encargo financeiro (multa ${formatBRL(late.fineCents)} + juros ${formatBRL(late.interestCents)} por ${daysLate} dia(s) de atraso, política padrão da empresa). O excedente é reconhecido como receita financeira; nenhuma tabela nova é criada — a decomposição é exposta neste resultado e no evento receivable.received.`
    );
  }

  if (input.bankAccountId) {
    const account = await ctx.repos.bankAccounts.getById(ctx.companyId, input.bankAccountId);
    if (!account) {
      return errorResult(SKILL_NAME, ctx, "bank_account_not_found", `Conta bancária não encontrada: ${input.bankAccountId}`);
    }
  }

  const now = ctx.clock.now().toISOString();
  const receipt: Receipt = {
    id: ctx.ids.next("rcp"),
    companyId: ctx.companyId,
    receivableId: receivable.id,
    bankAccountId: input.bankAccountId,
    // Registra o valor TOTAL de fato recebido (principal + encargos).
    amountCents: input.amountCents,
    receivedDate: input.receivedDate,
    method: input.method,
    registeredBy: ctx.actor.id,
    createdAt: now,
  };
  await ctx.repos.receipts.create(receipt);

  const before = { ...receivable };
  // Só o PRINCIPAL baixa o saldo do título — o excedente é encargo, não principal.
  receivable.receivedCents += principalCents;
  // Quitação com tolerância zero: só é "received" quando o saldo chega exatamente a 0.
  receivable.status = receivable.receivedCents === receivable.amountCents ? "received" : "partially_received";
  receivable.updatedAt = now;
  await ctx.repos.receivables.update(receivable);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "receivable.receipt_registered",
    entityType: "receivable",
    entityId: receivable.id,
    before,
    after: receivable,
    correlationId: ctx.correlationId,
  });

  const remainingCents = receivableRemainingCents(receivable);
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "receivable.received",
    payload: {
      receivableId: receivable.id,
      receiptId: receipt.id,
      customerId: receivable.customerId,
      amountCents: input.amountCents,
      principalCents,
      chargesCents,
      receivedDate: input.receivedDate,
      method: input.method,
      remainingCents,
      status: receivable.status,
    },
    source: SKILL_NAME,
    correlationId: ctx.correlationId,
  });

  const data: RegisterReceiptData = {
    receipt,
    receivable,
    remainingCents,
    principalCents,
    chargesCents,
    formula:
      "principal_aplicado = min(recebido, saldo); encargo = recebido - principal (só aceito se = multa+juros do atraso); saldo_restante = valor do título - Σ principais recebidos",
  };

  return makeResult(SKILL_NAME, ctx, data as ContasAReceberData, {
    assumptions,
    dataSources: ["receivables", "receipts"],
  });
}

async function projection(
  ctx: SkillContext,
  input: ProjectionInput
): Promise<SkillResult<ContasAReceberData>> {
  const horizonDays = input.horizonDays ?? 30;
  const today = ctx.today();
  const horizonEnd = addDays(today, horizonDays);

  const open = await ctx.repos.receivables.listByStatus(ctx.companyId, [
    "open",
    "partially_received",
  ]);
  const inWindow = open.filter((r) => r.dueDate >= today && r.dueDate <= horizonEnd);

  const weeksCount = Math.ceil(horizonDays / 7);
  const weekly: ProjectionWeek[] = [];
  for (let i = 0; i < weeksCount; i += 1) {
    const weekStart = addDays(today, i * 7);
    const weekEnd = minDate(addDays(today, i * 7 + 6), horizonEnd);
    const inWeek = inWindow.filter((r) => r.dueDate >= weekStart && r.dueDate <= weekEnd);
    weekly.push({
      week: i + 1,
      weekStart,
      weekEnd,
      expectedCents: inWeek.reduce((acc, r) => acc + receivableRemainingCents(r), 0),
      count: inWeek.length,
    });
  }

  const totalCents = weekly.reduce((acc, w) => acc + w.expectedCents, 0);
  const data: ProjectionData = {
    horizonDays,
    weekly,
    totalCents,
    formula:
      "entrada_semana = Σ (valor - recebido) dos títulos em aberto com vencimento dentro da semana",
    period: { start: today, end: horizonEnd },
  };

  return makeResult(SKILL_NAME, ctx, data as ContasAReceberData, {
    // Estimativa: assume recebimento no vencimento — não é fato realizado.
    confidence: 0.9,
    assumptions: [
      "A projeção assume que os títulos em aberto serão recebidos na data de vencimento.",
      "Títulos já vencidos antes de hoje não entram na projeção (ver ação list_overdue).",
    ],
    dataSources: ["receivables"],
  });
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const contasAReceberSkill: SkillDefinition<ContasAReceberInput, ContasAReceberData> = {
  name: SKILL_NAME,
  responsibility:
    "Contas a receber: clientes, títulos e parcelas; vencimentos e recebimentos; atrasos; projeção de entradas; baixa manual/automática. Integração Pix/boleto/cartão é conceitual (campo method).",
  objective:
    "Garantir visibilidade e controle das entradas: criar títulos idempotentes (inclusive a partir de faturas), detectar atrasos com encargos calculados, registrar baixas e projetar recebimentos.",
  inputSchema: contasAReceberInputSchema,
  consumes: ["invoice.issued"],
  publishes: ["receivable.created", "receivable.received", "receivable.overdue_detected"],
  dataSources: ["receivables", "customers", "invoices", "receipts"],
  async execute(ctx, input) {
    switch (input.action) {
      case "create_receivable":
        return createReceivable(ctx, input);
      case "create_from_invoice":
        return createFromInvoice(ctx, input);
      case "list_overdue":
        return listOverdue(ctx);
      case "register_receipt":
        return registerReceipt(ctx, input);
      case "projection":
        return projection(ctx, input);
      case "issue_charge":
        return issueCharge(ctx, input);
      case "generate_recurring":
        return generateRecurring(ctx);
    }
  },
};

/**
 * Gera os títulos a receber recorrentes devidos no mês corrente. Para cada
 * template ativo com kind=receivable dentro da janela, cria o título do mês
 * reaproveitando createReceivable — idempotente por originKey (não duplica).
 */
async function generateRecurring(
  ctx: SkillContext
): Promise<SkillResult<GenerateRecurringData>> {
  const today = ctx.today();
  const templates = await ctx.repos.recurringTemplates.listActive(ctx.companyId);
  const generated: GenerateRecurringData["generated"] = [];

  for (const t of templates) {
    if (t.kind !== "receivable") continue; // payable é do skill contas_a_pagar.
    const month = shouldGenerateFor(t, today);
    if (!month) continue;

    const dueDate = dueDateForMonth(t, month);
    const before = (await ctx.repos.receivables.listAll(ctx.companyId)).length;
    const result = await createReceivable(ctx, {
      action: "create_receivable",
      customerId: t.counterpartyId,
      description: `${t.description} (recorrência ${month})`,
      issueDate: dueDate,
      dueDate,
      amountCents: t.amountCents,
      installmentCount: 1,
    });
    const after = (await ctx.repos.receivables.listAll(ctx.companyId)).length;
    const receivable = (result.data as CreateReceivableData | null)?.receivables?.[0];
    if (receivable && after > before) {
      generated.push({ templateId: t.id, receivableId: receivable.id, dueDate });
    }
  }

  return makeResult(SKILL_NAME, ctx, { generated }, { dataSources: ["receivables"] });
}

/**
 * Emite código de cobrança (Pix copia-e-cola ou linha digitável de boleto) para
 * o saldo em aberto do título, via porta ChargeProvider — MOCK no MVP: o código
 * é fake e nada é registrado em PSP/banco. Idempotente: o mesmo título+tipo
 * gera sempre o mesmo chargeId; reemitir não duplica a anotação.
 */
async function issueCharge(
  ctx: SkillContext,
  input: IssueChargeInput
): Promise<SkillResult<ContasAReceberData>> {
  const receivable = await ctx.repos.receivables.getById(ctx.companyId, input.receivableId);
  if (!receivable) {
    return errorResult(SKILL_NAME, ctx, "not_found", `Título a receber não encontrado: ${input.receivableId}.`);
  }
  const remaining = receivableRemainingCents(receivable);
  if (remaining <= 0 || receivable.status === "canceled" || receivable.status === "received") {
    return errorResult(
      SKILL_NAME,
      ctx,
      "invalid_state",
      `Título ${receivable.id} não possui saldo em aberto para cobrança (status: ${receivable.status}).`
    );
  }
  const customer = await ctx.repos.customers.getById(ctx.companyId, receivable.customerId);
  if (!customer) {
    return errorResult(SKILL_NAME, ctx, "not_found", `Cliente não encontrado: ${receivable.customerId}.`);
  }

  const charge = await ctx.integrations.charges.createCharge({
    kind: input.kind,
    amountCents: remaining,
    dueDate: receivable.dueDate,
    customerName: customer.name,
    customerDocument: customer.document,
    receivableId: receivable.id,
  });

  // Idempotência da anotação: reemitir a mesma cobrança não duplica a nota.
  const noteLine = `Cobrança ${input.kind} (${charge.provider} ${charge.chargeId}): ${charge.code}`;
  const alreadyNoted = receivable.notes?.includes(charge.chargeId) ?? false;
  if (!alreadyNoted) {
    const before = { ...receivable };
    receivable.notes = receivable.notes ? `${receivable.notes}\n${noteLine}` : noteLine;
    receivable.updatedAt = ctx.clock.now().toISOString();
    await ctx.repos.receivables.update(receivable);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "receivable.charge_issued",
      entityType: "receivable",
      entityId: receivable.id,
      before,
      after: { ...receivable, chargeId: charge.chargeId, provider: charge.provider },
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "receivable.updated",
      payload: {
        receivableId: receivable.id,
        chargeId: charge.chargeId,
        kind: input.kind,
        provider: charge.provider,
        amountCents: remaining,
      },
      source: SKILL_NAME,
      correlationId: ctx.correlationId,
    });
  }

  const data: IssueChargeData = { charge, receivable, remainingCents: remaining };

  return makeResult(
    SKILL_NAME,
    ctx,
    data as ContasAReceberData,
    {
      assumptions: [
        `Código gerado pela porta de cobrança "${charge.provider}" — no provedor mock o código é fake e NENHUM registro é feito em PSP/banco; a liquidação real continua entrando pela conciliação do extrato.`,
        ...(alreadyNoted
          ? [`Cobrança ${charge.chargeId} já estava registrada no título; reemissão idempotente.`]
          : []),
      ],
      confidence: 1.0,
      dataSources: ["receivables", "customers", "integration:charges"],
    }
  );
}
