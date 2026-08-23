/**
 * Skill COBRANÇA E INADIMPLÊNCIA — segmentação de clientes por atraso e risco,
 * régua de cobrança com mensagens respeitosas, sugestões de renegociação e
 * indicadores de inadimplência.
 *
 * Restrições centrais:
 *  - NENHUMA mensagem é enviada sem aprovação humana explícita (o envio, mesmo
 *    aprovado, é MOCK no MVP — nenhum e-mail/WhatsApp real é disparado);
 *  - renegociação é RECOMENDAÇÃO: a skill nunca altera condições de títulos.
 */

import { z } from "zod";
import { addDays, addMonths, diffDays, formatBR, type ISODate } from "@/core/dates";
import type { CollectionMessage, Receivable } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import {
  computeLateFee,
  formatBRL,
  percentOf,
  receivableRemainingCents,
  splitInstallments,
} from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { ApprovalRequestData, PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL = "cobranca_inadimplencia" as const;
const DATA_SOURCES = ["receivables", "customers", "receipts", "collection_messages"];

// ---------------------------------------------------------------------------
// Política inicial (constantes nomeadas) — limiares configuráveis no futuro:
// o ajuste fino deve migrar para CompanyConfig; por ora ficam como política
// inicial explícita e documentada da skill.
// ---------------------------------------------------------------------------

/** Risco baixo: no máximo esta quantidade de títulos vencidos... */
const LOW_RISK_MAX_OVERDUE_COUNT = 1;
/** ...e total vencido abaixo de R$ 1.000,00. */
const LOW_RISK_MAX_OVERDUE_CENTS = 100_000;
/** Risco alto: a partir desta quantidade de títulos vencidos... */
const HIGH_RISK_MIN_OVERDUE_COUNT = 3;
/** ...OU total vencido acima de R$ 10.000,00. */
const HIGH_RISK_OVERDUE_CENTS_THRESHOLD = 1_000_000;
/** Inadimplência acima deste % da carteira ativa gera alerta "high_delinquency". */
const HIGH_DELINQUENCY_ALERT_PERCENT = 10;
/** Janela de recebimentos usada no cálculo aproximado do DSO. */
const DSO_WINDOW_DAYS = 90;
/** Meses de juros de parcelamento aplicados na opção 3x da renegociação. */
const RENEGOTIATION_3X_INTEREST_MONTHS = 3;

/** Buckets de aging (dias de atraso) — política inicial configurável. */
const AGING_BUCKETS: ReadonlyArray<{
  label: AgingBucketLabel;
  minDays: number;
  maxDays: number | null; // null = sem teto
}> = [
  { label: "1-7", minDays: 1, maxDays: 7 },
  { label: "8-30", minDays: 8, maxDays: 30 },
  { label: "31-60", minDays: 31, maxDays: 60 },
  { label: "60+", minDays: 61, maxDays: null },
];

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const segmentCustomersSchema = z.object({ action: z.literal("segment_customers") });
const runDunningSchema = z.object({ action: z.literal("run_dunning") });
const suggestRenegotiationSchema = z.object({
  action: z.literal("suggest_renegotiation"),
  receivableId: z.string().min(1),
});
const delinquencyIndicatorsSchema = z.object({ action: z.literal("delinquency_indicators") });

export const cobrancaInputSchema = z.discriminatedUnion("action", [
  segmentCustomersSchema,
  runDunningSchema,
  suggestRenegotiationSchema,
  delinquencyIndicatorsSchema,
]);

export type SegmentCustomersInput = z.infer<typeof segmentCustomersSchema>;
export type RunDunningInput = z.infer<typeof runDunningSchema>;
export type SuggestRenegotiationInput = z.infer<typeof suggestRenegotiationSchema>;
export type DelinquencyIndicatorsInput = z.infer<typeof delinquencyIndicatorsSchema>;
export type CobrancaInput = z.infer<typeof cobrancaInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export type AgingBucketLabel = "1-7" | "8-30" | "31-60" | "60+";
/** Sem acento por serem valores de máquina; exibição em pt-BR fica na UI. */
export type RiskLevel = "baixo" | "medio" | "alto";

export interface CustomerSegment {
  customerId: string;
  customerName: string;
  bucket: AgingBucketLabel;
  risk: RiskLevel;
  overdueCount: number;
  overdueCents: number;
  maxDaysLate: number;
}

export interface SegmentCustomersData {
  segments: CustomerSegment[];
  totalOverdueCents: number;
  formula: string;
  period: string;
}

export interface RunDunningData {
  messages: CollectionMessage[];
  sent: number;
  approvalRequest?: ApprovalRequestData;
  formula?: string;
  period?: string;
}

export interface RenegotiationInstallment {
  number: number;
  dueDate: ISODate;
  amountCents: number;
}

export interface RenegotiationOption {
  code: "avista_desconto_juros" | "parcelado_2x_sem_juros" | "parcelado_3x_juros_politica";
  label: string;
  totalCents: number;
  installments: RenegotiationInstallment[];
  formula: string;
}

export interface SuggestRenegotiationData {
  receivableId: string;
  customerId: string;
  principalCents: number;
  daysLate: number;
  fineCents: number;
  interestCents: number;
  totalWithChargesCents: number;
  chargesFormula: string;
  options: RenegotiationOption[];
  period: string;
}

export interface IndicatorMeta<V> {
  value: V;
  formula: string;
  period: string;
  sources: string[];
}

export interface DelinquencyIndicatorsData {
  indicators: {
    delinquencyRatePercent: IndicatorMeta<number | null>;
    agingCents: IndicatorMeta<Record<AgingBucketLabel, number>>;
    averageOverdueTicketCents: IndicatorMeta<number | null>;
    delinquentCustomerCount: IndicatorMeta<number>;
    dsoDays: IndicatorMeta<number | null>;
  };
}

export type CobrancaData =
  | SegmentCustomersData
  | RunDunningData
  | SuggestRenegotiationData
  | DelinquencyIndicatorsData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_STATUSES: Receivable["status"][] = ["open", "partially_received"];

function bucketFor(daysLate: number): AgingBucketLabel {
  for (const bucket of AGING_BUCKETS) {
    if (daysLate >= bucket.minDays && (bucket.maxDays === null || daysLate <= bucket.maxDays)) {
      return bucket.label;
    }
  }
  return "60+";
}

function riskFor(overdueCount: number, overdueCents: number): RiskLevel {
  if (
    overdueCount >= HIGH_RISK_MIN_OVERDUE_COUNT ||
    overdueCents > HIGH_RISK_OVERDUE_CENTS_THRESHOLD
  ) {
    return "alto";
  }
  if (overdueCount <= LOW_RISK_MAX_OVERDUE_COUNT && overdueCents < LOW_RISK_MAX_OVERDUE_CENTS) {
    return "baixo";
  }
  return "medio";
}

interface OverdueEntry {
  receivable: Receivable;
  remaining: number;
  daysLate: number;
}

/** Títulos vencidos da carteira ativa (open/partially_received, saldo > 0, dueDate < hoje). */
async function listOverdue(ctx: SkillContext, today: ISODate): Promise<OverdueEntry[]> {
  const open = await ctx.repos.receivables.listByStatus(ctx.companyId, OPEN_STATUSES);
  return open
    .filter((r) => r.dueDate < today && receivableRemainingCents(r) > 0)
    .map((r) => ({ receivable: r, remaining: receivableRemainingCents(r), daysLate: diffDays(r.dueDate, today) }))
    .sort((a, b) =>
      a.receivable.dueDate === b.receivable.dueDate
        ? a.receivable.id.localeCompare(b.receivable.id)
        : a.receivable.dueDate < b.receivable.dueDate
          ? -1
          : 1
    );
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** Persiste alerta apenas se não houver outro ABERTO com mesmo code+entityId (dedupe). */
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
// Ação 1 — segment_customers
// ---------------------------------------------------------------------------

async function segmentCustomers(ctx: SkillContext): Promise<SkillResult<SegmentCustomersData>> {
  const today = ctx.today();
  const overdue = await listOverdue(ctx, today);
  const assumptions: string[] = [
    `Política inicial configurável de risco: baixo = até ${LOW_RISK_MAX_OVERDUE_COUNT} título vencido e menos de ${formatBRL(LOW_RISK_MAX_OVERDUE_CENTS)} em aberto; alto = ${HIGH_RISK_MIN_OVERDUE_COUNT} ou mais títulos vencidos OU mais de ${formatBRL(HIGH_RISK_OVERDUE_CENTS_THRESHOLD)} em aberto; médio = demais casos.`,
  ];

  const byCustomer = new Map<string, { count: number; cents: number; maxDaysLate: number }>();
  for (const { receivable, remaining, daysLate } of overdue) {
    const agg = byCustomer.get(receivable.customerId) ?? { count: 0, cents: 0, maxDaysLate: 0 };
    agg.count += 1;
    agg.cents += remaining;
    agg.maxDaysLate = Math.max(agg.maxDaysLate, daysLate);
    byCustomer.set(receivable.customerId, agg);
  }

  const segments: CustomerSegment[] = [];
  for (const [customerId, agg] of byCustomer) {
    const customer = await ctx.repos.customers.getById(ctx.companyId, customerId);
    if (!customer) {
      assumptions.push(
        `Cliente ${customerId} sem cadastro; identificado pelo próprio id na segmentação.`
      );
    }
    segments.push({
      customerId,
      customerName: customer?.name ?? customerId,
      bucket: bucketFor(agg.maxDaysLate),
      risk: riskFor(agg.count, agg.cents),
      overdueCount: agg.count,
      overdueCents: agg.cents,
      maxDaysLate: agg.maxDaysLate,
    });
  }
  segments.sort((a, b) => b.overdueCents - a.overdueCents || a.customerId.localeCompare(b.customerId));

  const totalOverdueCents = segments.reduce((acc, s) => acc + s.overdueCents, 0);
  return makeResult(
    SKILL,
    ctx,
    {
      segments,
      totalOverdueCents,
      formula:
        "por cliente: overdueCents = Σ (amountCents - receivedCents) dos títulos open/partially_received com dueDate < hoje; bucket pelo MAIOR atraso do cliente (1-7 / 8-30 / 31-60 / 60+); risco pelos limiares da política inicial",
      period: `posição da carteira em ${today}`,
    },
    { assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Ação 2 — run_dunning (padrão de aprovação humana)
// ---------------------------------------------------------------------------

async function runDunning(ctx: SkillContext): Promise<SkillResult<RunDunningData>> {
  if (ctx.approval) return resumeDunningDecision(ctx);

  const today = ctx.today();
  const nowIso = ctx.clock.now().toISOString();
  const policy = ctx.config.lateFeeDefaults;
  const overdue = await listOverdue(ctx, today);
  const steps = [...ctx.config.dunningSteps].sort((a, b) => a.daysOverdue - b.daysOverdue);

  const formula = `encargos por título: total = saldo + multa (${policy.finePercent}%) + juros (${policy.monthlyInterestPercent}% a.m. pró-rata die) × dias de atraso; step escolhido = maior daysOverdue da régua ≤ dias de atraso do título`;
  const period = `títulos vencidos até ${today}`;

  if (overdue.length === 0) {
    return makeResult(
      SKILL,
      ctx,
      { messages: [], sent: 0, formula, period },
      {
        assumptions: ["Nenhum título elegível para a régua de cobrança: não há títulos vencidos."],
        confidence: 1.0,
        dataSources: DATA_SOURCES,
      }
    );
  }

  // Idempotência por (receivableId, step): mensagens não-canceladas bloqueiam novo rascunho.
  // O campo step da mensagem é o daysOverdue do degrau da régua (estável a reordenações).
  const allMessages = await ctx.repos.collectionMessages.listAll(ctx.companyId);
  const activePairs = new Set(
    allMessages.filter((m) => m.status !== "canceled").map((m) => `${m.receivableId}:${m.step}`)
  );

  const company = await ctx.repos.companies.getById(ctx.companyId);
  const companyName = company?.name ?? "nossa empresa";

  const assumptions: string[] = [];
  const drafted: CollectionMessage[] = [];
  let totalOverdueWithChargesCents = 0;
  let skippedExisting = 0;

  for (const { receivable, remaining, daysLate } of overdue) {
    const step = [...steps].reverse().find((s) => s.daysOverdue <= daysLate);
    if (!step) continue; // atraso ainda não alcançou o primeiro degrau da régua

    if (activePairs.has(`${receivable.id}:${step.daysOverdue}`)) {
      skippedExisting += 1;
      continue;
    }

    const late = computeLateFee(remaining, daysLate, policy);
    const customer = await ctx.repos.customers.getById(ctx.companyId, receivable.customerId);
    const vars: Record<string, string> = {
      cliente: customer?.name ?? receivable.customerId,
      valor: formatBRL(late.totalCents),
      vencimento: formatBR(receivable.dueDate),
      dias_atraso: String(daysLate),
      empresa: companyName,
    };

    const message: CollectionMessage = {
      id: ctx.ids.next("cmsg"),
      companyId: ctx.companyId,
      receivableId: receivable.id,
      customerId: receivable.customerId,
      step: step.daysOverdue,
      channel: step.channel,
      subject: renderTemplate(step.subject, vars),
      body: renderTemplate(step.template, vars),
      status: "awaiting_approval",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await ctx.repos.collectionMessages.create(message);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "collection.message_drafted",
      entityType: "collection_message",
      entityId: message.id,
      after: message,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "collection.message_drafted",
      payload: {
        id: message.id,
        receivableId: message.receivableId,
        customerId: message.customerId,
        step: message.step,
        channel: message.channel,
        amountCents: late.totalCents,
      },
      source: SKILL,
      correlationId: ctx.correlationId,
    });
    drafted.push(message);
    totalOverdueWithChargesCents += late.totalCents;
  }

  if (skippedExisting > 0) {
    assumptions.push(
      `${skippedExisting} título(s) já possuía(m) mensagem não-cancelada para o step correspondente; nenhum rascunho duplicado foi criado (idempotência por título+step).`
    );
  }

  if (drafted.length === 0) {
    const stillAwaiting = allMessages.filter((m) => m.status === "awaiting_approval");
    const pendingItems: PendingItem[] = stillAwaiting.map((m) => ({
      code: "mensagem_aguardando_aprovacao",
      description: `Mensagem de cobrança ${m.id} (título ${m.receivableId}, step ${m.step}) aguarda aprovação humana para envio.`,
      entityType: "collection_message",
      entityId: m.id,
      suggestedAction: "Aprovar ou rejeitar o envio da mensagem.",
    }));
    assumptions.push(
      "Nenhum título elegível para novo rascunho de cobrança nesta execução."
    );
    return makeResult(
      SKILL,
      ctx,
      { messages: [], sent: 0, formula, period },
      { assumptions, pendingItems, confidence: 1.0, dataSources: DATA_SOURCES }
    );
  }

  const approvalRequest: ApprovalRequestData = {
    targetType: "collection_message",
    targetId: ctx.correlationId,
    summary: `Enviar ${drafted.length} mensagem(ns) de cobrança — total ${formatBRL(totalOverdueWithChargesCents)}`,
    amountCents: totalOverdueWithChargesCents,
  };
  assumptions.push(
    "Nenhuma mensagem foi enviada: os rascunhos aguardam aprovação humana obrigatória; o envio, mesmo aprovado, é MOCK (nenhum e-mail/WhatsApp real)."
  );

  return makeResult(
    SKILL,
    ctx,
    { messages: drafted, sent: 0, approvalRequest, formula, period },
    {
      status: "awaiting_approval",
      requiresHumanApproval: true,
      assumptions,
      confidence: 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

/** Retomada pós-decisão humana: envia (mock) ou cancela as mensagens pendentes. */
async function resumeDunningDecision(ctx: SkillContext): Promise<SkillResult<RunDunningData>> {
  const decision = ctx.approval;
  if (!decision) throw new ValidationError("Retomada sem decisão de aprovação no contexto.");

  // Confere a Approval persistida antes de qualquer efeito — a decisão do
  // contexto nunca é aceita sem o registro correspondente no repositório.
  const approvalRecord = await ctx.repos.approvals.getById(ctx.companyId, decision.id);
  if (!approvalRecord) throw new NotFoundError("Aprovação", decision.id);
  if (approvalRecord.targetType !== "collection_message") {
    throw new ValidationError(
      `Aprovação ${approvalRecord.id} não se refere a mensagens de cobrança (targetType: ${approvalRecord.targetType}).`
    );
  }
  if (approvalRecord.status !== decision.status) {
    throw new ValidationError(
      `Decisão informada (${decision.status}) diverge do registro de aprovação (${approvalRecord.status}).`
    );
  }

  const nowIso = ctx.clock.now().toISOString();
  const awaiting = await ctx.repos.collectionMessages.listByStatus(ctx.companyId, [
    "awaiting_approval",
  ]);

  // Idempotência da retomada: decisão já aplicada não gera novo efeito.
  if (awaiting.length === 0) {
    const already = (await ctx.repos.collectionMessages.listAll(ctx.companyId)).filter(
      (m) => m.approvalId === decision.id
    );
    return makeResult(
      SKILL,
      ctx,
      {
        messages: already,
        sent: already.filter((m) => m.status === "sent").length,
      },
      {
        assumptions: [
          "Nenhuma mensagem pendente de aprovação; a decisão já havia sido aplicada (retomada idempotente, sem novo efeito).",
        ],
        confidence: 1.0,
        dataSources: DATA_SOURCES,
      }
    );
  }

  if (decision.status === "approved") {
    const sent: CollectionMessage[] = [];
    const customersById = new Map(
      (await ctx.repos.customers.listAll(ctx.companyId)).map((c) => [c.id, c])
    );
    for (const message of awaiting) {
      const before = { ...message };
      // Envio via porta MessagingProvider ("mock" no MVP: nenhum disparo real).
      const customer = customersById.get(message.customerId);
      const delivery = await ctx.integrations.messaging.send({
        channel: message.channel,
        to: customer?.email ?? `cliente:${message.customerId}`,
        subject: message.subject,
        body: message.body,
      });
      message.status = "sent";
      message.sentAt = nowIso;
      message.approvalId = decision.id;
      message.updatedAt = nowIso;
      await ctx.repos.collectionMessages.update(message);
      await ctx.audit.record(ctx.companyId, {
        actor: ctx.actor,
        action: "collection.message_sent",
        entityType: "collection_message",
        entityId: message.id,
        before,
        after: { ...message, deliveryProvider: delivery.provider, deliveryId: delivery.messageId },
        correlationId: ctx.correlationId,
      });
      await ctx.events.publish({
        companyId: ctx.companyId,
        type: "collection.message_sent",
        payload: {
          id: message.id,
          receivableId: message.receivableId,
          customerId: message.customerId,
          step: message.step,
          channel: message.channel,
          approvalId: decision.id,
          deliveryProvider: delivery.provider,
          deliveryId: delivery.messageId,
        },
        source: SKILL,
        correlationId: ctx.correlationId,
      });
      sent.push(message);
    }
    return makeResult(
      SKILL,
      ctx,
      { messages: sent, sent: sent.length },
      {
        assumptions: [
          `Envio aprovado por ${decision.decidedBy} via porta de mensageria "${ctx.integrations.messaging.provider}" — no provedor mock nenhum e-mail/WhatsApp real é disparado.`,
        ],
        confidence: 1.0,
        dataSources: DATA_SOURCES,
      }
    );
  }

  // Rejeitado: cancela os rascunhos pendentes (nada é enviado).
  const canceled: CollectionMessage[] = [];
  for (const message of awaiting) {
    const before = { ...message };
    message.status = "canceled";
    message.approvalId = decision.id;
    message.updatedAt = nowIso;
    await ctx.repos.collectionMessages.update(message);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "collection.message_canceled",
      entityType: "collection_message",
      entityId: message.id,
      before,
      after: message,
      correlationId: ctx.correlationId,
    });
    canceled.push(message);
  }
  return makeResult(
    SKILL,
    ctx,
    { messages: canceled, sent: 0 },
    {
      assumptions: [
        `Envio rejeitado por ${decision.decidedBy}${decision.justification ? ` (justificativa: ${decision.justification})` : ""}; mensagens canceladas e nada foi enviado.`,
      ],
      confidence: 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

// ---------------------------------------------------------------------------
// Ação 3 — suggest_renegotiation (recomendação; não altera nada)
// ---------------------------------------------------------------------------

async function suggestRenegotiation(
  ctx: SkillContext,
  input: SuggestRenegotiationInput
): Promise<SkillResult<SuggestRenegotiationData>> {
  const today = ctx.today();
  const policy = ctx.config.lateFeeDefaults;

  const receivable = await ctx.repos.receivables.getById(ctx.companyId, input.receivableId);
  if (!receivable) throw new NotFoundError("Título a receber", input.receivableId);
  if (!OPEN_STATUSES.includes(receivable.status)) {
    throw new ValidationError(
      `Título ${receivable.id} não permite renegociação (status atual: ${receivable.status}).`
    );
  }
  const principal = receivableRemainingCents(receivable);
  if (principal <= 0) {
    throw new ValidationError(`Título ${receivable.id} não possui saldo em aberto.`);
  }
  const daysLate = diffDays(receivable.dueDate, today);
  if (daysLate < 1) {
    throw new ValidationError(
      `Título ${receivable.id} não está vencido (vencimento em ${formatBR(receivable.dueDate)}); renegociação de inadimplência não se aplica.`
    );
  }

  const late = computeLateFee(principal, daysLate, policy);

  // Opção 1: à vista com desconto integral dos JUROS (multa mantida).
  const cashTotal = principal + late.fineCents;
  const cashOption: RenegotiationOption = {
    code: "avista_desconto_juros",
    label: "À vista com desconto dos juros (multa mantida)",
    totalCents: cashTotal,
    installments: [{ number: 1, dueDate: today, amountCents: cashTotal }],
    formula: `total = saldo (${formatBRL(principal)}) + multa ${policy.finePercent}% (${formatBRL(late.fineCents)}); juros de ${formatBRL(late.interestCents)} descontados integralmente para pagamento à vista`,
  };

  // Opção 2: 2x sem juros adicionais sobre o total com encargos.
  const twoParts = splitInstallments(late.totalCents, 2);
  const twoOption: RenegotiationOption = {
    code: "parcelado_2x_sem_juros",
    label: "2x sem juros adicionais",
    totalCents: late.totalCents,
    installments: twoParts.map((amountCents, i) => ({
      number: i + 1,
      dueDate: addMonths(today, i),
      amountCents,
    })),
    formula: `total = saldo + multa + juros = ${formatBRL(late.totalCents)}; parcelas = splitInstallments(${late.totalCents}, 2), sem juros adicionais`,
  };

  // Opção 3: 3x com juros de parcelamento da política (simples, sobre o total
  // com encargos, por RENEGOTIATION_3X_INTEREST_MONTHS meses).
  const financePercent = policy.monthlyInterestPercent * RENEGOTIATION_3X_INTEREST_MONTHS;
  const financeCents = percentOf(late.totalCents, financePercent);
  const threeTotal = late.totalCents + financeCents;
  const threeParts = splitInstallments(threeTotal, 3);
  const threeOption: RenegotiationOption = {
    code: "parcelado_3x_juros_politica",
    label: "3x com juros da política",
    totalCents: threeTotal,
    installments: threeParts.map((amountCents, i) => ({
      number: i + 1,
      dueDate: addMonths(today, i),
      amountCents,
    })),
    formula: `total = (saldo + multa + juros) × (1 + ${policy.monthlyInterestPercent}% × ${RENEGOTIATION_3X_INTEREST_MONTHS} meses) = ${formatBRL(late.totalCents)} + ${formatBRL(financeCents)}; parcelas = splitInstallments(${threeTotal}, 3)`,
  };

  return makeResult(
    SKILL,
    ctx,
    {
      receivableId: receivable.id,
      customerId: receivable.customerId,
      principalCents: principal,
      daysLate,
      fineCents: late.fineCents,
      interestCents: late.interestCents,
      totalWithChargesCents: late.totalCents,
      chargesFormula: late.formula,
      options: [cashOption, twoOption, threeOption],
      period: `cálculo na data ${today}, sobre ${daysLate} dia(s) de atraso`,
    },
    {
      // Sugestão apenas: qualquer alteração de condições exige decisão humana.
      requiresHumanApproval: true,
      confidence: 1.0,
      assumptions: [
        "Recomendação de renegociação: nenhuma condição do título foi alterada; alterar condições exige aprovação humana.",
        `Encargos e juros de parcelamento seguem a política padrão da empresa (multa ${policy.finePercent}%, juros ${policy.monthlyInterestPercent}% a.m.) — política inicial configurável, sujeita a validação humana.`,
        "Primeira parcela sugerida com vencimento hoje e demais mensais; datas podem ser ajustadas na negociação.",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

// ---------------------------------------------------------------------------
// Ação 4 — delinquency_indicators
// ---------------------------------------------------------------------------

async function delinquencyIndicators(
  ctx: SkillContext
): Promise<SkillResult<DelinquencyIndicatorsData>> {
  const today = ctx.today();
  const assumptions: string[] = [];
  const alerts: SkillAlert[] = [];

  const openReceivables = (
    await ctx.repos.receivables.listByStatus(ctx.companyId, OPEN_STATUSES)
  ).filter((r) => receivableRemainingCents(r) > 0);
  const overdue = openReceivables
    .filter((r) => r.dueDate < today)
    .map((r) => ({ receivable: r, remaining: receivableRemainingCents(r), daysLate: diffDays(r.dueDate, today) }));

  const openCents = openReceivables.reduce((acc, r) => acc + receivableRemainingCents(r), 0);
  const overdueCents = overdue.reduce((acc, o) => acc + o.remaining, 0);
  const positionPeriod = `posição da carteira em ${today}`;

  // Inadimplência % = vencido / total em aberto (2 casas decimais).
  const delinquencyRatePercent =
    openCents > 0 ? Math.round((overdueCents / openCents) * 10000) / 100 : null;
  if (delinquencyRatePercent === null) {
    assumptions.push("Carteira ativa sem saldo em aberto; percentual de inadimplência não calculado (null).");
  }

  const aging: Record<AgingBucketLabel, number> = { "1-7": 0, "8-30": 0, "31-60": 0, "60+": 0 };
  for (const o of overdue) aging[bucketFor(o.daysLate)] += o.remaining;

  const averageOverdueTicketCents =
    overdue.length > 0 ? Math.round(overdueCents / overdue.length) : null;
  if (averageOverdueTicketCents === null) {
    assumptions.push("Sem títulos vencidos; ticket médio vencido não calculado (null).");
  }

  const delinquentCustomerCount = new Set(overdue.map((o) => o.receivable.customerId)).size;

  // DSO aproximado = (saldo AR / recebimentos dos últimos 90 dias) × 90.
  const dsoStart = addDays(today, -DSO_WINDOW_DAYS);
  const receipts = await ctx.repos.receipts.listByDateRange(ctx.companyId, dsoStart, today);
  const receiptsCents = receipts.reduce((acc, r) => acc + r.amountCents, 0);
  const dsoDays =
    receiptsCents > 0 ? Math.round((openCents / receiptsCents) * DSO_WINDOW_DAYS * 10) / 10 : null;
  if (dsoDays === null) {
    assumptions.push(
      `Sem recebimentos registrados nos últimos ${DSO_WINDOW_DAYS} dias; DSO não calculado (null).`
    );
  } else {
    assumptions.push(
      "DSO é aproximação (count-back simplificado sobre recebimentos dos últimos 90 dias), não o DSO contábil exato."
    );
  }

  if (delinquencyRatePercent !== null && delinquencyRatePercent > HIGH_DELINQUENCY_ALERT_PERCENT) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "high_delinquency",
      message: `Inadimplência de ${delinquencyRatePercent}% da carteira ativa excede o limite de ${HIGH_DELINQUENCY_ALERT_PERCENT}% — total vencido ${formatBRL(overdueCents)}.`,
      entityType: "company",
      entityId: ctx.companyId,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  const data: DelinquencyIndicatorsData = {
    indicators: {
      delinquencyRatePercent: {
        value: delinquencyRatePercent,
        formula:
          "inadimplência % = (Σ saldo dos títulos vencidos / Σ saldo dos títulos em aberto da carteira ativa) × 100",
        period: positionPeriod,
        sources: ["receivables"],
      },
      agingCents: {
        value: aging,
        formula:
          "aging = Σ saldo (amountCents - receivedCents) dos títulos vencidos por bucket de dias de atraso (1-7 / 8-30 / 31-60 / 60+)",
        period: positionPeriod,
        sources: ["receivables"],
      },
      averageOverdueTicketCents: {
        value: averageOverdueTicketCents,
        formula: "ticket médio vencido = Σ saldo vencido / quantidade de títulos vencidos",
        period: positionPeriod,
        sources: ["receivables"],
      },
      delinquentCustomerCount: {
        value: delinquentCustomerCount,
        formula: "clientes inadimplentes = contagem de clientes distintos com ao menos um título vencido",
        period: positionPeriod,
        sources: ["receivables", "customers"],
      },
      dsoDays: {
        value: dsoDays,
        formula: `DSO ≈ (saldo total em aberto / recebimentos dos últimos ${DSO_WINDOW_DAYS} dias) × ${DSO_WINDOW_DAYS}`,
        period: `recebimentos de ${dsoStart} a ${today}`,
        sources: ["receivables", "receipts"],
      },
    },
  };

  return makeResult(SKILL, ctx, data, {
    alerts,
    assumptions,
    // DSO aproximado é estimativa → confiança rebaixada quando calculado.
    confidence: dsoDays === null ? 1.0 : 0.9,
    dataSources: DATA_SOURCES,
  });
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const cobrancaSkill: SkillDefinition<CobrancaInput, CobrancaData> = {
  name: SKILL,
  responsibility:
    "Segmentação de clientes por atraso e risco; régua de cobrança com mensagens respeitosas e aprovação humana obrigatória antes de qualquer envio (mock); sugestões de renegociação; indicadores de inadimplência.",
  objective:
    "Reduzir a inadimplência com cobrança respeitosa e controlada por humanos, dando visibilidade de risco por cliente e da saúde da carteira de recebíveis.",
  inputSchema: cobrancaInputSchema,
  consumes: ["receivable.overdue_detected"],
  publishes: ["collection.message_drafted", "collection.message_sent"],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "segment_customers":
        return segmentCustomers(ctx);
      case "run_dunning":
        return runDunning(ctx);
      case "suggest_renegotiation":
        return suggestRenegotiation(ctx, input);
      case "delinquency_indicators":
        return delinquencyIndicators(ctx);
    }
  },
};
