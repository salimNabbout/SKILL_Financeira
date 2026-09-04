/**
 * Skill CONTROLES INTERNOS, RISCOS E AUDITORIA — segregação de funções,
 * detecção de duplicidades e transações suspeitas, verificação da trilha de
 * auditoria imutável (hash-chain), conferência de alçadas de aprovação e
 * relatório consolidado de exceções.
 *
 * Esta skill só LÊ e ALERTA: nunca movimenta dinheiro nem altera títulos —
 * ela recomenda ações e registra alertas/eventos para decisão humana.
 */

import { z } from "zod";
import { persistAlert } from "@/core/alerts";
import { roleAtLeast } from "@/core/auth";
import { verifyChain } from "@/core/audit";
import { diffDays, todayInTz, type ISODate } from "@/core/dates";
import type { Payable, RoleName } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import { requiredRoleForAmount } from "@/core/config";
import { formatBRL } from "@/core/money";
import { median, robustZScore, ROBUST_OUTLIER_THRESHOLD } from "@/core/stats";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { AlertSeverity, PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL = "controles_internos_auditoria" as const;
const DATA_SOURCES = [
  "payables",
  "payments",
  "approvals",
  "bank_transactions",
  "audit_records",
  "alerts",
  "memberships",
];

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const validatePayablesSchema = z.object({
  action: z.literal("validate_payables"),
  payableIds: z.array(z.string().min(1)),
});

const postPaymentCheckSchema = z.object({
  action: z.literal("post_payment_check"),
  paymentId: z.string().min(1),
});

const scanAnomaliesSchema = z.object({
  action: z.literal("scan_anomalies"),
});

const verifyAuditChainSchema = z.object({
  action: z.literal("verify_audit_chain"),
});

const exceptionReportSchema = z.object({
  action: z.literal("exception_report"),
});

export const controlesInternosInputSchema = z.discriminatedUnion("action", [
  validatePayablesSchema,
  postPaymentCheckSchema,
  scanAnomaliesSchema,
  verifyAuditChainSchema,
  exceptionReportSchema,
]);

export type ValidatePayablesInput = z.infer<typeof validatePayablesSchema>;
export type PostPaymentCheckInput = z.infer<typeof postPaymentCheckSchema>;
export type ScanAnomaliesInput = z.infer<typeof scanAnomaliesSchema>;
export type VerifyAuditChainInput = z.infer<typeof verifyAuditChainSchema>;
export type ExceptionReportInput = z.infer<typeof exceptionReportSchema>;
export type ControlesInternosInput = z.infer<typeof controlesInternosInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface PayableCheck {
  payableId: string;
  duplicates: string[];
  requiredRoleForPayment: RoleName;
  issues: string[];
}

export interface ValidatePayablesData {
  checks: PayableCheck[];
}

export interface PaymentCheckItem {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface PostPaymentCheckData {
  paymentId: string;
  checks: PaymentCheckItem[];
}

export interface AnomalyEntry {
  type: string;
  severity: AlertSeverity;
  entityType: string;
  entityId: string;
  detail: string;
}

export interface ScanAnomaliesData {
  anomalies: AnomalyEntry[];
}

export interface VerifyAuditChainData {
  valid: boolean;
  brokenAtSeq?: number;
  totalRecords: number;
}

export interface ExceptionSectionItem {
  entityType?: string;
  entityId?: string;
  description: string;
}

export interface ExceptionSection {
  id: string;
  title: string;
  count: number;
  items: ExceptionSectionItem[];
}

export interface ExceptionReportData {
  sections: ExceptionSection[];
}

export type ControlesInternosData =
  | ValidatePayablesData
  | PostPaymentCheckData
  | ScanAnomaliesData
  | VerifyAuditChainData
  | ExceptionReportData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persiste alerta apenas se não houver outro ABERTO com mesmo code+entityId. */
async function persistAlertDeduped(ctx: SkillContext, alert: SkillAlert): Promise<void> {
  await persistAlert(ctx, alert, SKILL);
}

async function publishAnomaly(
  ctx: SkillContext,
  payload: Record<string, unknown>
): Promise<void> {
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "controls.anomaly_detected",
    payload,
    source: SKILL,
    correlationId: ctx.correlationId,
  });
}

/** Data de negócio (fuso da empresa) de um carimbo ISO-8601 UTC. */
function businessDateOf(ctx: SkillContext, isoTimestamp: string): ISODate {
  return todayInTz(new Date(isoTimestamp), ctx.config.timezone);
}

// ---------------------------------------------------------------------------
// validate_payables
// ---------------------------------------------------------------------------

async function validatePayables(
  ctx: SkillContext,
  input: ValidatePayablesInput
): Promise<SkillResult<ValidatePayablesData>> {
  const allPayables = await ctx.repos.payables.listAll(ctx.companyId);
  const notCanceled = allPayables.filter((p) => p.status !== "canceled");
  const alerts: SkillAlert[] = [];
  const checks: PayableCheck[] = [];

  for (const payableId of input.payableIds) {
    const payable = await ctx.repos.payables.getById(ctx.companyId, payableId);
    if (!payable) throw new NotFoundError("Título a pagar", payableId);

    const issues: string[] = [];

    // (a) Duplicidade: mesmo fornecedor+valor+vencimento com originKey distinta,
    // ou mesmo documento fiscal vinculado a outro título.
    const duplicates = notCanceled
      .filter(
        (other: Payable) =>
          other.id !== payable.id &&
          ((other.supplierId === payable.supplierId &&
            other.amountCents === payable.amountCents &&
            other.dueDate === payable.dueDate &&
            other.originKey !== payable.originKey) ||
            // Mesmo documento fiscal só é duplicidade na MESMA parcela — parcelas
            // distintas do mesmo documento são legítimas (compra parcelada).
            (payable.documentId !== undefined &&
              other.documentId === payable.documentId &&
              other.installmentNumber === payable.installmentNumber))
      )
      .map((other) => other.id)
      .sort();

    if (duplicates.length > 0) {
      const issue = `Possível duplicidade com o(s) título(s) ${duplicates.join(", ")} (mesmo fornecedor/valor/vencimento ou mesmo documento fiscal).`;
      issues.push(issue);
      const alert: SkillAlert = {
        severity: "warning",
        code: "possible_duplicate_payable",
        message: `Título ${payable.id}: ${issue}`,
        entityType: "payable",
        entityId: payable.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
    }

    // (b) Alçada: papel mínimo que será exigido para aprovar o pagamento do
    // título (calculado sobre o valor total do título — informativo).
    const requiredRoleForPayment = requiredRoleForAmount(ctx.config, payable.amountCents);

    // (c) Cadastro do fornecedor.
    const supplier = await ctx.repos.suppliers.getById(ctx.companyId, payable.supplierId);
    if (!supplier) {
      issues.push(`Fornecedor ${payable.supplierId} não encontrado no cadastro.`);
    } else if (!supplier.document) {
      issues.push(`Fornecedor ${supplier.name} (${supplier.id}) sem CNPJ/CPF cadastrado.`);
    }

    checks.push({ payableId, duplicates, requiredRoleForPayment, issues });
  }

  const hasIssues = checks.some((c) => c.issues.length > 0);
  return makeResult(
    SKILL,
    ctx,
    { checks },
    {
      status: hasIssues ? "warning" : "success",
      alerts,
      confidence: 1.0,
      assumptions: [
        "Duplicidades apontadas são SUSPEITAS determinísticas (fornecedor+valor+vencimento ou documento compartilhado) e exigem confirmação humana antes de qualquer cancelamento.",
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

// ---------------------------------------------------------------------------
// post_payment_check
// ---------------------------------------------------------------------------

/** Regras cuja violação indica falha grave de controle (status "error"). */
const CRITICAL_RULES = new Set(["approval_exists", "approval_approved", "segregation"]);

async function postPaymentCheck(
  ctx: SkillContext,
  input: PostPaymentCheckInput
): Promise<SkillResult<PostPaymentCheckData>> {
  const payment = await ctx.repos.payments.getById(ctx.companyId, input.paymentId);
  if (!payment) throw new NotFoundError("Pagamento", input.paymentId);

  const checks: PaymentCheckItem[] = [];
  const assumptions: string[] = [];
  if (payment.status !== "executed") {
    assumptions.push(
      `Pagamento ${payment.id} ainda não executado (status: ${payment.status}); verificação aplicada preventivamente.`
    );
  }

  const approval = payment.approvalId
    ? await ctx.repos.approvals.getById(ctx.companyId, payment.approvalId)
    : null;
  checks.push({
    rule: "approval_exists",
    passed: approval !== null,
    detail: approval
      ? `Aprovação ${approval.id} localizada no repositório.`
      : "Pagamento sem registro de aprovação vinculado (approvalId ausente ou inválido).",
  });

  if (approval) {
    checks.push({
      rule: "approval_approved",
      passed: approval.status === "approved",
      detail:
        approval.status === "approved"
          ? "Aprovação com status aprovado."
          : `Aprovação com status "${approval.status}" (esperado "approved").`,
    });

    const decidedBy = approval.decidedBy;
    checks.push({
      rule: "segregation",
      passed: decidedBy !== undefined && decidedBy !== payment.requestedBy,
      detail:
        decidedBy === undefined
          ? "Aprovação sem decisor registrado."
          : decidedBy === payment.requestedBy
            ? `Violação de segregação de funções: solicitante e aprovador são o mesmo usuário (${decidedBy}).`
            : `Solicitante (${payment.requestedBy}) e aprovador (${decidedBy}) distintos.`,
    });

    const membership = decidedBy
      ? await ctx.repos.memberships.findByUserAndCompany(decidedBy, ctx.companyId)
      : null;
    if (membership) {
      const withinLimit =
        membership.approvalLimitCents === null ||
        payment.amountCents <= membership.approvalLimitCents;
      checks.push({
        rule: "approver_limit",
        passed: withinLimit,
        detail: withinLimit
          ? `Valor ${formatBRL(payment.amountCents)} dentro do limite de alçada do aprovador (${membership.approvalLimitCents === null ? "ilimitado" : formatBRL(membership.approvalLimitCents)}).`
          : `Valor ${formatBRL(payment.amountCents)} EXCEDE o limite de alçada do aprovador (${formatBRL(membership.approvalLimitCents as number)}).`,
      });
      const roleOk = roleAtLeast(membership.role, approval.requiredRole);
      checks.push({
        rule: "approver_role",
        passed: roleOk,
        detail: roleOk
          ? `Papel do aprovador (${membership.role}) atende ao mínimo exigido (${approval.requiredRole}).`
          : `Papel do aprovador (${membership.role}) ABAIXO do mínimo exigido (${approval.requiredRole}).`,
      });
    } else {
      checks.push({
        rule: "approver_limit",
        passed: false,
        detail: decidedBy
          ? `Aprovador ${decidedBy} sem vínculo (membership) com a empresa — alçada não verificável.`
          : "Sem decisor registrado — alçada não verificável.",
      });
      checks.push({
        rule: "approver_role",
        passed: false,
        detail: decidedBy
          ? `Aprovador ${decidedBy} sem vínculo (membership) com a empresa — papel não verificável.`
          : "Sem decisor registrado — papel não verificável.",
      });
    }
  }

  const failures = checks.filter((c) => !c.passed);
  const alerts: SkillAlert[] = [];
  if (failures.length > 0) {
    const alert: SkillAlert = {
      severity: "critical",
      code: "control_violation",
      message: `Pagamento ${payment.id} com violação de controle: ${failures.map((f) => f.detail).join(" | ")}`,
      entityType: "payment",
      entityId: payment.id,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
    await publishAnomaly(ctx, {
      type: "control_violation",
      paymentId: payment.id,
      amountCents: payment.amountCents,
      violations: failures.map((f) => ({ rule: f.rule, detail: f.detail })),
    });
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "controls.violation_detected",
      entityType: "payment",
      entityId: payment.id,
      after: { checks },
      correlationId: ctx.correlationId,
    });
  }

  // Falha em regra crítica (aprovação ausente/não aprovada/autoaprovação) →
  // "error"; falha só de alçada/papel → "warning"; tudo passou → "success".
  const status = failures.some((f) => CRITICAL_RULES.has(f.rule))
    ? "error"
    : failures.length > 0
      ? "warning"
      : "success";

  return makeResult(
    SKILL,
    ctx,
    { paymentId: payment.id, checks },
    { status, alerts, assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// scan_anomalies
// ---------------------------------------------------------------------------

async function scanAnomalies(ctx: SkillContext): Promise<SkillResult<ScanAnomaliesData>> {
  const anomalies: AnomalyEntry[] = [];
  const assumptions: string[] = [];

  // (a) Transações bancárias duplicadas: mesma conta+valor+data+descrição com
  // externalId diferente (mesmo externalId já é deduplicado na importação).
  const transactions = await ctx.repos.bankTransactions.listAll(ctx.companyId);
  const txGroups = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    const key = `${tx.bankAccountId}|${tx.date}|${tx.amountCents}|${tx.description}`;
    const list = txGroups.get(key) ?? [];
    list.push(tx);
    txGroups.set(key, list);
  }
  for (const group of txGroups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].externalId !== group[j].externalId) {
          const ids = [group[i].id, group[j].id].sort();
          anomalies.push({
            type: "duplicate_bank_transaction",
            severity: "warning",
            entityType: "bank_transaction",
            entityId: ids.join("+"),
            detail: `Transações ${ids.join(" e ")} com mesmo valor (${formatBRL(group[i].amountCents)}), data (${group[i].date}) e descrição ("${group[i].description}") mas identificadores externos distintos.`,
          });
        }
      }
    }
  }

  // (b) Valor atípico por conta. Amostra pequena (5–11): piso determinístico
  // |valor| > 3× média de |valores|. Amostra maior (≥ 12): escore robusto de
  // Iglewicz–Hoaglin (mediana/MAD), que resiste a outliers legítimos na base —
  // marca |z| > 3.5, com guarda de 2× mediana para séries quase constantes.
  const STATISTICAL_MIN_SAMPLE = 12;
  const byAccount = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    const list = byAccount.get(tx.bankAccountId) ?? [];
    list.push(tx);
    byAccount.set(tx.bankAccountId, list);
  }
  for (const [accountId, txs] of byAccount) {
    if (txs.length < 5) {
      assumptions.push(
        `Conta ${accountId} com apenas ${txs.length} transação(ões) (< 5): análise de valor atípico pulada por amostra insuficiente.`
      );
      continue;
    }
    const absolutes = txs.map((t) => Math.abs(t.amountCents));
    if (txs.length < STATISTICAL_MIN_SAMPLE) {
      const mean = absolutes.reduce((acc, v) => acc + v, 0) / txs.length;
      for (const tx of txs) {
        if (Math.abs(tx.amountCents) > 3 * mean) {
          anomalies.push({
            type: "unusual_transaction_amount",
            severity: "warning",
            entityType: "bank_transaction",
            entityId: tx.id,
            detail: `Transação ${tx.id} de ${formatBRL(tx.amountCents)} excede 3× a média de valores absolutos da conta ${accountId} (média ${formatBRL(Math.round(mean))}).`,
          });
        }
      }
      continue;
    }
    const med = median(absolutes);
    for (const tx of txs) {
      const abs = Math.abs(tx.amountCents);
      const z = robustZScore(abs, absolutes);
      if (z > ROBUST_OUTLIER_THRESHOLD && abs > 2 * med) {
        anomalies.push({
          type: "unusual_transaction_amount",
          severity: "warning",
          entityType: "bank_transaction",
          entityId: tx.id,
          detail: `Transação ${tx.id} de ${formatBRL(tx.amountCents)} com escore robusto ${Number.isFinite(z) ? z.toFixed(1) : ">3.5"} acima do limiar ${ROBUST_OUTLIER_THRESHOLD} na conta ${accountId} (mediana de |valores| ${formatBRL(Math.round(med))}, método Iglewicz–Hoaglin sobre mediana/MAD).`,
        });
      }
    }
  }

  // (c) Pagamentos executados sem aprovação vinculada — CRÍTICO.
  const executedPayments = await ctx.repos.payments.listByStatus(ctx.companyId, ["executed"]);
  for (const payment of executedPayments) {
    if (!payment.approvalId) {
      anomalies.push({
        type: "payment_without_approval",
        severity: "critical",
        entityType: "payment",
        entityId: payment.id,
        detail: `Pagamento ${payment.id} de ${formatBRL(payment.amountCents)} executado SEM aprovação vinculada (approvalId ausente).`,
      });
    }
  }

  // (d) Pagamentos executados que somam mais que o valor do título.
  const byPayable = new Map<string, typeof executedPayments>();
  for (const payment of executedPayments) {
    const list = byPayable.get(payment.payableId) ?? [];
    list.push(payment);
    byPayable.set(payment.payableId, list);
  }
  for (const [payableId, payments] of byPayable) {
    const payable = await ctx.repos.payables.getById(ctx.companyId, payableId);
    if (!payable) continue;
    const totalPaid = payments.reduce((acc, p) => acc + p.amountCents, 0);
    if (totalPaid > payable.amountCents) {
      anomalies.push({
        type: "overpayment",
        severity: "critical",
        entityType: "payable",
        entityId: payableId,
        detail: `Título ${payableId} de ${formatBRL(payable.amountCents)} possui ${payments.length} pagamento(s) executado(s) somando ${formatBRL(totalPaid)} — valor pago excede o título.`,
      });
    }
  }

  const alerts: SkillAlert[] = [];
  for (const anomaly of anomalies) {
    const alert: SkillAlert = {
      severity: anomaly.severity,
      code: anomaly.type,
      message: anomaly.detail,
      entityType: anomaly.entityType,
      entityId: anomaly.entityId,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
    await publishAnomaly(ctx, {
      type: anomaly.type,
      severity: anomaly.severity,
      entityType: anomaly.entityType,
      entityId: anomaly.entityId,
      detail: anomaly.detail,
    });
  }

  return makeResult(
    SKILL,
    ctx,
    { anomalies },
    {
      alerts,
      // Regras (a), (c) e (d) são determinísticas; (b) é limiar estatístico
      // (3× média ou escore robusto) — o conjunto é triagem, não confirmação.
      confidence: 0.9,
      assumptions: [
        "Anomalias são suspeitas para investigação humana; nenhuma transação foi bloqueada ou revertida automaticamente.",
        "Valor atípico: com 5–11 transações na conta, piso determinístico |valor| > 3× média de |valores|; com 12 ou mais, escore robusto de Iglewicz–Hoaglin (mediana/MAD) > 3.5 com guarda de 2× mediana.",
        ...assumptions,
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

// ---------------------------------------------------------------------------
// verify_audit_chain
// ---------------------------------------------------------------------------

async function verifyAuditChain(ctx: SkillContext): Promise<SkillResult<VerifyAuditChainData>> {
  const records = await ctx.repos.audit.list(ctx.companyId);
  // Passa a âncora do head persistida para detectar truncamento do FIM da trilha.
  const head = await ctx.repos.audit.getHead(ctx.companyId);
  const result = verifyChain(records, head ?? undefined);

  const alerts: SkillAlert[] = [];
  if (!result.valid) {
    const alert: SkillAlert = {
      severity: "critical",
      code: "audit_chain_broken",
      message: `Trilha de auditoria ADULTERADA: cadeia de hashes quebrada no registro de sequência ${result.brokenAtSeq}.`,
      entityType: "audit_record",
      entityId: String(result.brokenAtSeq),
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
    await publishAnomaly(ctx, {
      type: "audit_chain_broken",
      brokenAtSeq: result.brokenAtSeq,
      totalRecords: records.length,
    });
  }

  return makeResult(
    SKILL,
    ctx,
    { valid: result.valid, brokenAtSeq: result.brokenAtSeq, totalRecords: records.length },
    { alerts, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// exception_report
// ---------------------------------------------------------------------------

const PENDING_APPROVAL_MAX_DAYS = 3;

async function exceptionReport(ctx: SkillContext): Promise<SkillResult<ExceptionReportData>> {
  const today = ctx.today();
  const pendingItems: PendingItem[] = [];

  // 1. Alertas abertos por severidade.
  const openAlerts = await ctx.repos.alerts.listOpen(ctx.companyId);
  const bySeverity: Record<AlertSeverity, number> = { info: 0, warning: 0, critical: 0 };
  for (const a of openAlerts) bySeverity[a.severity] += 1;
  const alertsSection: ExceptionSection = {
    id: "open_alerts",
    title: "Alertas abertos por severidade",
    count: openAlerts.length,
    items: (["critical", "warning", "info"] as AlertSeverity[]).map((sev) => ({
      description: `${sev}: ${bySeverity[sev]} alerta(s) aberto(s)`,
    })),
  };

  // 2. Aprovações pendentes há mais de 3 dias.
  const pendingApprovals = (
    await ctx.repos.approvals.listByStatus(ctx.companyId, ["pending"])
  ).filter((a) => diffDays(businessDateOf(ctx, a.createdAt), today) > PENDING_APPROVAL_MAX_DAYS);
  const approvalsSection: ExceptionSection = {
    id: "stale_approvals",
    title: `Aprovações pendentes há mais de ${PENDING_APPROVAL_MAX_DAYS} dias`,
    count: pendingApprovals.length,
    items: pendingApprovals.map((a) => ({
      entityType: "approval",
      entityId: a.id,
      description: `Aprovação ${a.id} (${a.summary}) pendente desde ${businessDateOf(ctx, a.createdAt)}${a.amountCents !== undefined ? ` — ${formatBRL(a.amountCents)}` : ""}.`,
    })),
  };
  for (const a of pendingApprovals) {
    pendingItems.push({
      code: "stale_approval",
      description: `Aprovação ${a.id} pendente há mais de ${PENDING_APPROVAL_MAX_DAYS} dias: ${a.summary}`,
      entityType: "approval",
      entityId: a.id,
      suggestedAction: "Decidir (aprovar/rejeitar) a solicitação pendente ou expirar a aprovação.",
    });
  }

  // 3. Sugestões de conciliação pendentes de confirmação humana.
  const suggestedMatches = await ctx.repos.reconciliations.listByStatus(ctx.companyId, [
    "suggested",
  ]);
  const reconciliationSection: ExceptionSection = {
    id: "pending_reconciliations",
    title: "Sugestões de conciliação aguardando confirmação",
    count: suggestedMatches.length,
    items: suggestedMatches.map((m) => ({
      entityType: "reconciliation_match",
      entityId: m.id,
      description: `Sugestão ${m.id} (transação ${m.bankTransactionId} → ${m.targetType}${m.targetId ? ` ${m.targetId}` : ""}, confiança ${m.confidence}).`,
    })),
  };
  for (const m of suggestedMatches) {
    pendingItems.push({
      code: "reconciliation_suggested",
      description: `Sugestão de conciliação ${m.id} aguardando confirmação humana.`,
      entityType: "reconciliation_match",
      entityId: m.id,
      suggestedAction: "Confirmar ou rejeitar a sugestão de conciliação.",
    });
  }

  // 4. Integridade da trilha de auditoria (com âncora do head para truncamento).
  const records = await ctx.repos.audit.list(ctx.companyId);
  const auditHead = await ctx.repos.audit.getHead(ctx.companyId);
  const chain = verifyChain(records, auditHead ?? undefined);
  const chainSection: ExceptionSection = {
    id: "audit_chain",
    title: "Integridade da trilha de auditoria",
    count: chain.valid ? 0 : 1,
    items: [
      {
        description: chain.valid
          ? `Cadeia íntegra (${records.length} registro(s) verificados).`
          : `Cadeia QUEBRADA no registro de sequência ${chain.brokenAtSeq} (${records.length} registro(s)).`,
      },
    ],
  };
  const alerts: SkillAlert[] = [];
  if (!chain.valid) {
    const alert: SkillAlert = {
      severity: "critical",
      code: "audit_chain_broken",
      message: `Trilha de auditoria ADULTERADA: cadeia de hashes quebrada no registro de sequência ${chain.brokenAtSeq}.`,
      entityType: "audit_record",
      entityId: String(chain.brokenAtSeq),
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
    pendingItems.push({
      code: "audit_chain_broken",
      description: `Trilha de auditoria com cadeia quebrada na sequência ${chain.brokenAtSeq}.`,
      entityType: "audit_record",
      entityId: String(chain.brokenAtSeq),
      suggestedAction: "Investigar imediatamente a adulteração da trilha de auditoria.",
    });
  }

  const sections = [alertsSection, approvalsSection, reconciliationSection, chainSection];
  const hasExceptions =
    bySeverity.critical + bySeverity.warning > 0 ||
    pendingApprovals.length > 0 ||
    suggestedMatches.length > 0 ||
    !chain.valid;

  return makeResult(
    SKILL,
    ctx,
    { sections },
    {
      status: hasExceptions ? "warning" : "success",
      alerts,
      pendingItems,
      confidence: 1.0,
      assumptions: [
        `Janela de aprovação pendente considerada: mais de ${PENDING_APPROVAL_MAX_DAYS} dias corridos a partir da data de solicitação (fuso da empresa).`,
      ],
      dataSources: DATA_SOURCES,
    }
  );
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const controlesInternosSkill: SkillDefinition<
  ControlesInternosInput,
  ControlesInternosData
> = {
  name: SKILL,
  responsibility:
    "Segregação de funções, detecção de duplicidades e transações suspeitas, verificação da trilha de auditoria imutável, conferência de limites de alçada e relatórios de exceção.",
  objective:
    "Detectar e alertar violações de controle interno antes que causem perda financeira, garantindo trilha de auditoria íntegra e decisões dentro da alçada — sem nunca executar ações financeiras.",
  inputSchema: controlesInternosInputSchema,
  consumes: [],
  publishes: ["controls.anomaly_detected"],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "validate_payables":
        return validatePayables(ctx, input);
      case "post_payment_check":
        return postPaymentCheck(ctx, input);
      case "scan_anomalies":
        return scanAnomalies(ctx);
      case "verify_audit_chain":
        return verifyAuditChain(ctx);
      case "exception_report":
        return exceptionReport(ctx);
    }
  },
};
