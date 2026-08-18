/**
 * Skill CONCILIAÇÃO BANCÁRIA — importa extratos (OFX/CSV; API bancária e Open
 * Finance são MOCKS declarados, não usados no MVP), deduplica transações,
 * compara o extrato com contas a pagar/receber e pagamentos executados,
 * concilia automaticamente com grau de confiança, encaminha divergências para
 * revisão humana e mantém o histórico de correspondências (ReconciliationMatch).
 *
 * Restrições centrais:
 * - a skill NUNCA movimenta dinheiro: ela registra FATOS bancários (o dinheiro
 *   já entrou/saiu) e recomenda; ordens futuras de pagamento continuam
 *   governadas pelo fluxo de aprovação humana de contas a pagar;
 * - baixa de débito casado com título NÃO cria Payment retroativo — o registro
 *   fica no próprio título (paidCents) + match + auditoria;
 * - reimportar o mesmo arquivo é idempotente (dedupe por externalId).
 */

import { z } from "zod";
import { assertPermission } from "@/core/auth";
import { diffDays, endOfMonth, monthOf, startOfMonth, type ISODate } from "@/core/dates";
import type {
  BankTransaction,
  ID,
  Receipt,
  ReconciliationMatch,
} from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import { hashPayload } from "@/core/ids";
import { formatBRL } from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";
import { normalizeText, parseCsvStatement, parseOfx } from "@/lib/importers";

const SKILL = "conciliacao_bancaria" as const;
const DATA_SOURCES = ["bank_transactions", "payables", "receivables", "payments", "receipts"];

const SETTLEMENT_ASSUMPTION =
  "Liquidação registrada via conciliação; aprovação de pagamento governa ordens futuras, não fatos bancários.";

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const importStatementSchema = z.object({
  action: z.literal("import_statement"),
  bankAccountId: z.string().min(1),
  format: z.enum(["ofx", "csv"]),
  content: z.string().min(1),
});

const autoMatchSchema = z.object({
  action: z.literal("auto_match"),
  bankAccountId: z.string().min(1).optional(),
});

const confirmMatchSchema = z.object({
  action: z.literal("confirm_match"),
  matchId: z.string().min(1),
});

const rejectMatchSchema = z.object({
  action: z.literal("reject_match"),
  matchId: z.string().min(1),
  notes: z.string().optional(),
});

const reconciliationStatusSchema = z.object({
  action: z.literal("reconciliation_status"),
});

export const conciliacaoInputSchema = z.discriminatedUnion("action", [
  importStatementSchema,
  autoMatchSchema,
  confirmMatchSchema,
  rejectMatchSchema,
  reconciliationStatusSchema,
]);

export type ImportStatementInput = z.infer<typeof importStatementSchema>;
export type AutoMatchInput = z.infer<typeof autoMatchSchema>;
export type ConfirmMatchInput = z.infer<typeof confirmMatchSchema>;
export type RejectMatchInput = z.infer<typeof rejectMatchSchema>;
export type ReconciliationStatusInput = z.infer<typeof reconciliationStatusSchema>;
export type ConciliacaoInput = z.infer<typeof conciliacaoInputSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface ImportStatementData {
  bankAccountId: ID;
  importBatchId: string;
  format: "ofx" | "csv";
  imported: number;
  duplicates: number;
  warnings: string[];
  /** Apenas as transações NOVAS inseridas nesta importação. */
  transactions: BankTransaction[];
}

export interface AutoMatchData {
  autoConfirmed: number;
  suggested: number;
  unmatched: number;
  /** Matches criados nesta rodada (auto-confirmados e sugeridos). */
  matches: ReconciliationMatch[];
  formula: string;
  /** Intervalo de datas das transações avaliadas (null se nenhuma). */
  period: { start: ISODate; end: ISODate } | null;
}

export interface ConfirmMatchData {
  match: ReconciliationMatch;
  receipt?: Receipt;
}

export interface RejectMatchData {
  match: ReconciliationMatch;
}

export interface ReconciliationStatusData {
  unreconciledCount: number;
  suggestedPendingCount: number;
  reconciledInMonthCount: number;
  suggestions: Array<{
    matchId: ID;
    bankTransactionId: ID;
    targetType: ReconciliationMatch["targetType"];
    targetId?: ID;
    confidence: number;
  }>;
  period: { start: ISODate; end: ISODate };
  formula: string;
}

export type ConciliacaoData =
  | ImportStatementData
  | AutoMatchData
  | ConfirmMatchData
  | RejectMatchData
  | ReconciliationStatusData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persiste alerta apenas se não houver outro ABERTO com mesmo code+entityId. */
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

/** Arredonda a 2 casas para evitar ruído de ponto flutuante na soma dos pesos. */
function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

// Sufixos societários não contam como "parte do nome" (evita falso positivo
// com descrições que contêm "LTDA", "SA" etc. de outras empresas).
const NAME_STOPWORDS = new Set(["ltda", "eireli", "epp", "cia", "sa", "mei", "me"]);

function nameTokens(name: string | undefined): string[] {
  if (!name) return [];
  return normalizeText(name)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t));
}

function confidenceFormula(ctx: SkillContext): string {
  const { reconciliationAmountToleranceCents, reconciliationDateToleranceDays, reconciliationAutoConfirmThreshold } =
    ctx.config;
  return (
    `confiança do par = valor (igual: 0,55; diferença <= ${reconciliationAmountToleranceCents} centavos: 0,40) ` +
    `+ data (mesmo dia: +0,25; até ${reconciliationDateToleranceDays} dia(s): +0,15) ` +
    `+ descrição contém parte (>=4 letras) do nome da contraparte: +0,20; ` +
    `casa se > 0,50; baixa automática se >= ${reconciliationAutoConfirmThreshold}`
  );
}

interface ScoreResult {
  score: number;
  dateDiff: number;
  breakdown: string;
}

/**
 * Fórmula de confiança (documentada em confidenceFormula):
 *   valor exato = 0,55; dentro da tolerância de centavos = 0,40 (fora: não é candidato);
 *   data igual = +0,25; dentro da tolerância de dias = +0,15;
 *   descrição contém parte (>=4 chars) do nome da contraparte = +0,20.
 */
function scoreCandidate(
  ctx: SkillContext,
  tx: BankTransaction,
  candidateCents: number,
  candidateDate: ISODate,
  counterpartyName: string | undefined
): ScoreResult | null {
  const txAbs = Math.abs(tx.amountCents);
  const amountDiff = Math.abs(txAbs - candidateCents);
  let amountComponent: number;
  if (amountDiff === 0) amountComponent = 0.55;
  else if (amountDiff <= ctx.config.reconciliationAmountToleranceCents) amountComponent = 0.4;
  else return null;

  const dateDiff = Math.abs(diffDays(candidateDate, tx.date));
  let dateComponent = 0;
  if (dateDiff === 0) dateComponent = 0.25;
  else if (dateDiff <= ctx.config.reconciliationDateToleranceDays) dateComponent = 0.15;

  const description = normalizeText(tx.description);
  const matchedToken = nameTokens(counterpartyName).find((t) => description.includes(t));
  const nameComponent = matchedToken ? 0.2 : 0;

  return {
    score: roundScore(amountComponent + dateComponent + nameComponent),
    dateDiff,
    breakdown:
      `valor=${amountComponent.toFixed(2)} (diferença ${amountDiff} centavo(s)); ` +
      `data=${dateComponent.toFixed(2)} (${dateDiff} dia(s)); ` +
      `nome=${nameComponent.toFixed(2)}${matchedToken ? ` ("${matchedToken}")` : ""}`,
  };
}

async function markTransactionReconciled(ctx: SkillContext, tx: BankTransaction): Promise<void> {
  const before = { ...tx };
  tx.reconciled = true;
  await ctx.repos.bankTransactions.update(tx);
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "bank_transaction.reconciled",
    entityType: "bank_transaction",
    entityId: tx.id,
    before,
    after: tx,
    correlationId: ctx.correlationId,
  });
}

/**
 * Aplica a baixa correspondente ao match (usada na conciliação automática e no
 * confirm_match). Regras:
 * - crédito casando título a receber → cria Receipt (registeredBy "system",
 *   method "transfer") e atualiza receivable com a regra padrão de status;
 * - débito casando título a pagar → atualiza paidCents/status; NÃO cria
 *   Payment retroativo (o dinheiro já saiu — fato bancário, não ordem futura);
 * - débito casando pagamento executado → nada a baixar (só marca conciliado).
 */
async function applySettlement(
  ctx: SkillContext,
  tx: BankTransaction,
  match: Pick<ReconciliationMatch, "targetType" | "targetId">
): Promise<{ receipt?: Receipt; assumptions: string[] }> {
  if (!match.targetId) {
    throw new ValidationError("Conciliação sem alvo definido não pode ser aplicada.");
  }
  const nowIso = ctx.clock.now().toISOString();
  const assumptions: string[] = [];

  if (match.targetType === "receivable") {
    if (tx.amountCents <= 0) {
      throw new ValidationError(
        `Transação ${tx.id} não é um crédito; não pode baixar título a receber.`
      );
    }
    const receivable = await ctx.repos.receivables.getById(ctx.companyId, match.targetId);
    if (!receivable) throw new NotFoundError("Título a receber", match.targetId);
    const remaining = receivable.amountCents - receivable.receivedCents;
    if (remaining <= 0 || receivable.status === "canceled" || receivable.status === "received") {
      throw new ValidationError(
        `Título a receber ${receivable.id} não possui saldo em aberto para conciliar (status: ${receivable.status}).`
      );
    }
    const receipt: Receipt = {
      id: ctx.ids.next("rcp"),
      companyId: ctx.companyId,
      receivableId: receivable.id,
      bankAccountId: tx.bankAccountId,
      amountCents: tx.amountCents,
      receivedDate: tx.date,
      method: "transfer",
      registeredBy: "system",
      createdAt: nowIso,
    };
    await ctx.repos.receipts.create(receipt);
    const before = { ...receivable };
    receivable.receivedCents += tx.amountCents;
    receivable.status = receivable.receivedCents >= receivable.amountCents ? "received" : "partially_received";
    receivable.updatedAt = nowIso;
    await ctx.repos.receivables.update(receivable);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "receipt.created",
      entityType: "receipt",
      entityId: receipt.id,
      after: receipt,
      correlationId: ctx.correlationId,
    });
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "receivable.updated",
      entityType: "receivable",
      entityId: receivable.id,
      before,
      after: receivable,
      correlationId: ctx.correlationId,
    });
    if (tx.amountCents !== remaining) {
      assumptions.push(
        `Diferença de ${formatBRL(Math.abs(tx.amountCents - remaining))} entre o crédito bancário e o saldo do título ${receivable.id} absorvida dentro da tolerância configurada.`
      );
    }
    return { receipt, assumptions };
  }

  if (match.targetType === "payable") {
    if (tx.amountCents >= 0) {
      throw new ValidationError(`Transação ${tx.id} não é um débito; não pode baixar título a pagar.`);
    }
    const amount = -tx.amountCents;
    const payable = await ctx.repos.payables.getById(ctx.companyId, match.targetId);
    if (!payable) throw new NotFoundError("Título a pagar", match.targetId);
    const remaining = payable.amountCents - payable.paidCents;
    if (remaining <= 0 || payable.status === "canceled" || payable.status === "paid") {
      throw new ValidationError(
        `Título a pagar ${payable.id} não possui saldo em aberto para conciliar (status: ${payable.status}).`
      );
    }
    const before = { ...payable };
    payable.paidCents += amount;
    payable.status = payable.paidCents >= payable.amountCents ? "paid" : "partially_paid";
    payable.updatedAt = nowIso;
    await ctx.repos.payables.update(payable);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "payable.settled_via_reconciliation",
      entityType: "payable",
      entityId: payable.id,
      before,
      after: payable,
      correlationId: ctx.correlationId,
    });
    assumptions.push(SETTLEMENT_ASSUMPTION);
    if (amount !== remaining) {
      assumptions.push(
        `Diferença de ${formatBRL(Math.abs(amount - remaining))} entre o débito bancário e o saldo do título ${payable.id} absorvida dentro da tolerância configurada.`
      );
    }
    return { assumptions };
  }

  // targetType === "payment": o pagamento executado já baixou o título na
  // skill de contas a pagar — aqui apenas registramos a correspondência.
  const payment = await ctx.repos.payments.getById(ctx.companyId, match.targetId);
  if (!payment) throw new NotFoundError("Pagamento", match.targetId);
  assumptions.push(
    `Transação casada com o pagamento ${payment.id} já executado; o título vinculado não sofre nova baixa.`
  );
  return { assumptions };
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function importStatement(
  ctx: SkillContext,
  input: ImportStatementInput
): Promise<SkillResult<ImportStatementData>> {
  assertPermission(ctx.actor, "reconciliation.manage");

  const account = await ctx.repos.bankAccounts.getById(ctx.companyId, input.bankAccountId);
  if (!account) throw new NotFoundError("Conta bancária", input.bankAccountId);
  if (!account.active) {
    throw new ValidationError(`Conta bancária inativa: ${account.name} (${account.id}).`);
  }

  const parsed = input.format === "ofx" ? parseOfx(input.content) : parseCsvStatement(input.content);
  const importBatchId = ctx.ids.next("imp");
  const nowIso = ctx.clock.now().toISOString();

  let duplicates = 0;
  const created: BankTransaction[] = [];
  for (let seq = 0; seq < parsed.transactions.length; seq++) {
    const t = parsed.transactions[seq];
    // Chave natural: FITID do banco ou hash determinístico do conteúdo + posição
    // no arquivo (duas transações idênticas legítimas no MESMO arquivo entram;
    // reimportar o mesmo arquivo não duplica nada).
    const externalId =
      t.fitid ??
      hashPayload({ date: t.date, amountCents: t.amountCents, description: t.description, seq });
    const existing = await ctx.repos.bankTransactions.findByExternalId(
      ctx.companyId,
      input.bankAccountId,
      externalId
    );
    if (existing) {
      duplicates++;
      continue;
    }
    const tx: BankTransaction = {
      id: ctx.ids.next("btx"),
      companyId: ctx.companyId,
      bankAccountId: input.bankAccountId,
      date: t.date,
      amountCents: t.amountCents,
      currency: account.currency,
      description: t.description,
      externalId,
      importBatchId,
      source: input.format,
      reconciled: false,
      createdAt: nowIso,
    };
    await ctx.repos.bankTransactions.create(tx);
    created.push(tx);
  }

  // Auditoria em nível de lote (uma entrada por importação, com os ids criados,
  // para não inflar a trilha com centenas de registros por arquivo).
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "statement.imported",
    entityType: "import_batch",
    entityId: importBatchId,
    after: {
      bankAccountId: input.bankAccountId,
      format: input.format,
      imported: created.length,
      duplicates,
      warnings: parsed.warnings.length,
      transactionIds: created.map((t) => t.id),
    },
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "statement.imported",
    payload: {
      bankAccountId: input.bankAccountId,
      importBatchId,
      format: input.format,
      imported: created.length,
      duplicates,
      warnings: parsed.warnings.length,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  const alerts: SkillAlert[] = [];
  if (parsed.transactions.length === 0) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "statement_empty",
      message: `Nenhuma transação válida encontrada no arquivo ${input.format.toUpperCase()} importado.`,
      entityType: "import_batch",
      entityId: importBatchId,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  } else if (parsed.warnings.length > 0) {
    const alert: SkillAlert = {
      severity: "warning",
      code: "statement_parse_warnings",
      message: `${parsed.warnings.length} linha(s)/registro(s) do extrato ignorado(s) por formato inválido — revisar o arquivo importado.`,
      entityType: "import_batch",
      entityId: importBatchId,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  const assumptions: string[] = [
    "Fonte dos dados: arquivo enviado manualmente (OFX/CSV). Integrações de API bancária e Open Finance são MOCKS declarados e não foram utilizadas.",
  ];
  if (duplicates > 0) {
    assumptions.push(
      `${duplicates} transação(ões) já existiam (mesmo externalId) e não foram inseridas novamente — reimportação idempotente.`
    );
  }
  if (parsed.accountId) {
    assumptions.push(
      `Identificador de conta no arquivo ("${parsed.accountId}") não é validado contra o número mascarado da conta cadastrada.`
    );
  }

  return makeResult(
    SKILL,
    ctx,
    {
      bankAccountId: input.bankAccountId,
      importBatchId,
      format: input.format,
      imported: created.length,
      duplicates,
      warnings: parsed.warnings,
      transactions: created,
    },
    { alerts, assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

interface Candidate extends ScoreResult {
  targetType: "payable" | "receivable" | "payment";
  targetId: ID;
}

// Empate: pagamento executado tem prioridade sobre baixar o título de novo
// (evita dupla baixa quando o mesmo valor tem pagamento já registrado).
const TARGET_PRIORITY: Record<Candidate["targetType"], number> = {
  payment: 0,
  payable: 1,
  receivable: 1,
};

function bestFirst(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (TARGET_PRIORITY[a.targetType] !== TARGET_PRIORITY[b.targetType]) {
    return TARGET_PRIORITY[a.targetType] - TARGET_PRIORITY[b.targetType];
  }
  if (a.dateDiff !== b.dateDiff) return a.dateDiff - b.dateDiff;
  return a.targetId < b.targetId ? -1 : 1;
}

async function autoMatch(
  ctx: SkillContext,
  input: AutoMatchInput
): Promise<SkillResult<AutoMatchData>> {
  assertPermission(ctx.actor, "reconciliation.manage");
  if (input.bankAccountId) {
    const account = await ctx.repos.bankAccounts.getById(ctx.companyId, input.bankAccountId);
    if (!account) throw new NotFoundError("Conta bancária", input.bankAccountId);
  }

  const unreconciled = await ctx.repos.bankTransactions.listUnreconciled(ctx.companyId);
  const txs = (
    input.bankAccountId
      ? unreconciled.filter((t) => t.bankAccountId === input.bankAccountId)
      : unreconciled
  ).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));

  const payables = await ctx.repos.payables.listByStatus(ctx.companyId, [
    "open",
    "scheduled",
    "partially_paid",
  ]);
  const receivables = await ctx.repos.receivables.listByStatus(ctx.companyId, [
    "open",
    "partially_received",
  ]);
  const executedPayments = await ctx.repos.payments.listByStatus(ctx.companyId, ["executed"]);
  const allMatches = await ctx.repos.reconciliations.listAll(ctx.companyId);
  const suppliers = new Map(
    (await ctx.repos.suppliers.listAll(ctx.companyId)).map((s) => [s.id, s.name])
  );
  const customers = new Map(
    (await ctx.repos.customers.listAll(ctx.companyId)).map((c) => [c.id, c.name])
  );
  const payableById = new Map(
    (await ctx.repos.payables.listAll(ctx.companyId)).map((p) => [p.id, p])
  );

  const activeStatuses = new Set(["suggested", "auto_confirmed", "confirmed"]);
  const matchedPaymentIds = new Set(
    allMatches
      .filter((m) => m.targetType === "payment" && m.targetId && activeStatuses.has(m.status))
      .map((m) => m.targetId as ID)
  );
  const pendingByTx = new Map(
    allMatches.filter((m) => m.status === "suggested").map((m) => [m.bankTransactionId, m])
  );
  // Par transação+alvo já rejeitado por humano não é sugerido novamente.
  const rejectedPairs = new Set(
    allMatches
      .filter((m) => m.status === "rejected" && m.targetId)
      .map((m) => `${m.bankTransactionId}|${m.targetId}`)
  );

  // Controle de saldo restante EM MEMÓRIA durante o lote: um título não pode
  // ser casado por duas transações além do saldo.
  const payableRemaining = new Map(payables.map((p) => [p.id, p.amountCents - p.paidCents]));
  const receivableRemaining = new Map(
    receivables.map((r) => [r.id, r.amountCents - r.receivedCents])
  );
  // Sugestões pendentes de rodadas anteriores também reservam saldo do alvo.
  for (const m of pendingByTx.values()) {
    if (!m.targetId) continue;
    const pendingTx = await ctx.repos.bankTransactions.getById(ctx.companyId, m.bankTransactionId);
    const abs = pendingTx ? Math.abs(pendingTx.amountCents) : 0;
    if (m.targetType === "payable" && payableRemaining.has(m.targetId)) {
      payableRemaining.set(m.targetId, Math.max(0, (payableRemaining.get(m.targetId) ?? 0) - abs));
    } else if (m.targetType === "receivable" && receivableRemaining.has(m.targetId)) {
      receivableRemaining.set(
        m.targetId,
        Math.max(0, (receivableRemaining.get(m.targetId) ?? 0) - abs)
      );
    }
  }

  let autoConfirmed = 0;
  let suggested = 0;
  let unmatched = 0;
  let skippedPending = 0;
  const matches: ReconciliationMatch[] = [];
  const alerts: SkillAlert[] = [];
  const pendingItems: PendingItem[] = [];
  const assumptions: string[] = [];

  for (const tx of txs) {
    if (pendingByTx.has(tx.id)) {
      skippedPending++;
      continue;
    }
    const txAbs = Math.abs(tx.amountCents);
    const candidates: Candidate[] = [];

    if (tx.amountCents < 0) {
      // Débito: pagamentos executados sem match e títulos a pagar com saldo.
      for (const pmt of executedPayments) {
        if (matchedPaymentIds.has(pmt.id)) continue;
        if (rejectedPairs.has(`${tx.id}|${pmt.id}`)) continue;
        const supplierName = suppliers.get(payableById.get(pmt.payableId)?.supplierId ?? "");
        const s = scoreCandidate(ctx, tx, pmt.amountCents, pmt.scheduledDate, supplierName);
        if (s && s.score > 0.5) candidates.push({ targetType: "payment", targetId: pmt.id, ...s });
      }
      for (const p of payables) {
        const remaining = payableRemaining.get(p.id) ?? 0;
        if (remaining <= 0) continue;
        if (rejectedPairs.has(`${tx.id}|${p.id}`)) continue;
        const s = scoreCandidate(ctx, tx, remaining, p.dueDate, suppliers.get(p.supplierId));
        if (s && s.score > 0.5) candidates.push({ targetType: "payable", targetId: p.id, ...s });
      }
    } else if (tx.amountCents > 0) {
      // Crédito: títulos a receber com saldo.
      for (const r of receivables) {
        const remaining = receivableRemaining.get(r.id) ?? 0;
        if (remaining <= 0) continue;
        if (rejectedPairs.has(`${tx.id}|${r.id}`)) continue;
        const s = scoreCandidate(ctx, tx, remaining, r.dueDate, customers.get(r.customerId));
        if (s && s.score > 0.5) candidates.push({ targetType: "receivable", targetId: r.id, ...s });
      }
    }

    if (candidates.length === 0) {
      unmatched++;
      continue;
    }
    candidates.sort(bestFirst);
    const best = candidates[0];
    const nowIso = ctx.clock.now().toISOString();
    const isAuto = best.score >= ctx.config.reconciliationAutoConfirmThreshold;

    const match: ReconciliationMatch = {
      id: ctx.ids.next("rec"),
      companyId: ctx.companyId,
      bankTransactionId: tx.id,
      targetType: best.targetType,
      targetId: best.targetId,
      confidence: best.score,
      status: isAuto ? "auto_confirmed" : "suggested",
      matchedBy: "system",
      notes: best.breakdown,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await ctx.repos.reconciliations.create(match);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: isAuto ? "reconciliation.auto_matched" : "reconciliation.suggested",
      entityType: "reconciliation_match",
      entityId: match.id,
      after: match,
      correlationId: ctx.correlationId,
    });

    // Reserva o saldo do alvo (auto ou sugerido) para as próximas transações do lote.
    if (best.targetType === "payable") {
      payableRemaining.set(best.targetId, Math.max(0, (payableRemaining.get(best.targetId) ?? 0) - txAbs));
    } else if (best.targetType === "receivable") {
      receivableRemaining.set(
        best.targetId,
        Math.max(0, (receivableRemaining.get(best.targetId) ?? 0) - txAbs)
      );
    } else {
      matchedPaymentIds.add(best.targetId);
    }

    if (isAuto) {
      const settlement = await applySettlement(ctx, tx, match);
      for (const a of settlement.assumptions) {
        if (!assumptions.includes(a)) assumptions.push(a);
      }
      await markTransactionReconciled(ctx, tx);
      await ctx.events.publish({
        companyId: ctx.companyId,
        type: "reconciliation.auto_matched",
        payload: {
          matchId: match.id,
          bankTransactionId: tx.id,
          targetType: match.targetType,
          targetId: match.targetId,
          confidence: match.confidence,
          amountCents: tx.amountCents,
        },
        source: SKILL,
        correlationId: ctx.correlationId,
      });
      autoConfirmed++;
    } else {
      await ctx.events.publish({
        companyId: ctx.companyId,
        type: "reconciliation.suggested",
        payload: {
          matchId: match.id,
          bankTransactionId: tx.id,
          targetType: match.targetType,
          targetId: match.targetId,
          confidence: match.confidence,
          amountCents: tx.amountCents,
        },
        source: SKILL,
        correlationId: ctx.correlationId,
      });
      pendingItems.push({
        code: "reconciliation_suggested",
        description: `Transação ${tx.id} (${formatBRL(tx.amountCents)} em ${tx.date}) sugerida para ${match.targetType} ${match.targetId} com confiança ${match.confidence.toFixed(2)}.`,
        entityType: "reconciliation_match",
        entityId: match.id,
        suggestedAction: "Revisar e usar confirm_match ou reject_match.",
      });
      const alert: SkillAlert = {
        severity: "info",
        code: "reconciliation_review",
        message: `Sugestão de conciliação aguardando revisão humana: transação ${tx.id} ↔ ${match.targetType} ${match.targetId} (confiança ${match.confidence.toFixed(2)}).`,
        entityType: "reconciliation_match",
        entityId: match.id,
      };
      alerts.push(alert);
      await persistAlertDeduped(ctx, alert);
      suggested++;
    }
    matches.push(match);
  }

  if (skippedPending > 0) {
    assumptions.push(
      `${skippedPending} transação(ões) com sugestão pendente de revisão humana foram ignoradas nesta rodada (sugestões não são duplicadas).`
    );
  }
  const evaluated = txs.length - skippedPending;
  if (evaluated > 0) {
    assumptions.push(
      "Correspondências calculadas por heurística determinística de valor/data/descrição; sugestões exigem confirmação humana."
    );
  }

  const processedDates = txs.map((t) => t.date);
  const period =
    processedDates.length > 0
      ? {
          start: processedDates.reduce((a, b) => (a < b ? a : b)),
          end: processedDates.reduce((a, b) => (a > b ? a : b)),
        }
      : null;

  return makeResult(
    SKILL,
    ctx,
    {
      autoConfirmed,
      suggested,
      unmatched,
      matches,
      formula: confidenceFormula(ctx),
      period,
    },
    {
      alerts,
      pendingItems,
      assumptions,
      // Matching é heurístico: confiança < 1.0 quando houve transações avaliadas.
      confidence: evaluated > 0 ? 0.85 : 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

async function confirmMatch(
  ctx: SkillContext,
  input: ConfirmMatchInput
): Promise<SkillResult<ConfirmMatchData>> {
  assertPermission(ctx.actor, "reconciliation.manage");

  const match = await ctx.repos.reconciliations.getById(ctx.companyId, input.matchId);
  if (!match) throw new NotFoundError("Conciliação", input.matchId);
  if (match.status === "confirmed" || match.status === "auto_confirmed") {
    return makeResult(
      SKILL,
      ctx,
      { match },
      {
        assumptions: [
          `Conciliação ${match.id} já estava aplicada (status "${match.status}"); confirmação idempotente sem novo efeito.`,
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (match.status === "rejected") {
    throw new ValidationError(
      `Conciliação ${match.id} foi rejeitada; execute auto_match novamente para gerar nova sugestão.`
    );
  }

  const tx = await ctx.repos.bankTransactions.getById(ctx.companyId, match.bankTransactionId);
  if (!tx) throw new NotFoundError("Transação bancária", match.bankTransactionId);
  if (tx.reconciled) {
    throw new ValidationError(`Transação ${tx.id} já está conciliada por outro caminho.`);
  }

  const { receipt, assumptions } = await applySettlement(ctx, tx, match);

  const before = { ...match };
  const nowIso = ctx.clock.now().toISOString();
  match.status = "confirmed";
  match.matchedBy = ctx.actor.id;
  match.updatedAt = nowIso;
  await ctx.repos.reconciliations.update(match);
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "reconciliation.confirmed",
    entityType: "reconciliation_match",
    entityId: match.id,
    before,
    after: match,
    correlationId: ctx.correlationId,
  });
  await markTransactionReconciled(ctx, tx);
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "reconciliation.confirmed",
    payload: {
      matchId: match.id,
      bankTransactionId: tx.id,
      targetType: match.targetType,
      targetId: match.targetId,
      confidence: match.confidence,
      confirmedBy: ctx.actor.id,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    { match, receipt },
    { assumptions, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

async function rejectMatch(
  ctx: SkillContext,
  input: RejectMatchInput
): Promise<SkillResult<RejectMatchData>> {
  assertPermission(ctx.actor, "reconciliation.manage");

  const match = await ctx.repos.reconciliations.getById(ctx.companyId, input.matchId);
  if (!match) throw new NotFoundError("Conciliação", input.matchId);
  if (match.status === "rejected") {
    return makeResult(
      SKILL,
      ctx,
      { match },
      {
        assumptions: [`Conciliação ${match.id} já estava rejeitada; rejeição idempotente sem novo efeito.`],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (match.status !== "suggested") {
    throw new ValidationError(
      `Conciliação ${match.id} já foi aplicada (status "${match.status}"); estorno não é suportado no MVP.`
    );
  }

  const before = { ...match };
  const nowIso = ctx.clock.now().toISOString();
  match.status = "rejected";
  match.matchedBy = ctx.actor.id;
  if (input.notes) match.notes = input.notes;
  match.updatedAt = nowIso;
  await ctx.repos.reconciliations.update(match);
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "reconciliation.rejected",
    entityType: "reconciliation_match",
    entityId: match.id,
    before,
    after: match,
    correlationId: ctx.correlationId,
  });

  // Defensivo: sugestão nunca concilia a transação, mas garantimos o estado.
  const tx = await ctx.repos.bankTransactions.getById(ctx.companyId, match.bankTransactionId);
  if (tx && tx.reconciled) {
    const txBefore = { ...tx };
    tx.reconciled = false;
    await ctx.repos.bankTransactions.update(tx);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "bank_transaction.unreconciled",
      entityType: "bank_transaction",
      entityId: tx.id,
      before: txBefore,
      after: tx,
      correlationId: ctx.correlationId,
    });
  }

  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "reconciliation.rejected",
    payload: {
      matchId: match.id,
      bankTransactionId: match.bankTransactionId,
      targetType: match.targetType,
      targetId: match.targetId,
      rejectedBy: ctx.actor.id,
      notes: input.notes,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    { match },
    {
      assumptions: [
        "Transação volta a ficar não conciliada e elegível em novas rodadas de auto_match; o mesmo par rejeitado não é sugerido novamente.",
      ],
      confidence: 1.0,
      dataSources: DATA_SOURCES,
    }
  );
}

async function reconciliationStatus(
  ctx: SkillContext
): Promise<SkillResult<ReconciliationStatusData>> {
  assertPermission(ctx.actor, "report.view");

  const unreconciled = await ctx.repos.bankTransactions.listUnreconciled(ctx.companyId);
  const suggestedMatches = await ctx.repos.reconciliations.listByStatus(ctx.companyId, [
    "suggested",
  ]);
  const month = monthOf(ctx.today());
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const inMonth = await ctx.repos.bankTransactions.listByDateRange(ctx.companyId, start, end);
  const reconciledInMonth = inMonth.filter((t) => t.reconciled);

  const pendingItems: PendingItem[] = suggestedMatches.map((m) => ({
    code: "reconciliation_suggested",
    description: `Sugestão de conciliação pendente: transação ${m.bankTransactionId} ↔ ${m.targetType} ${m.targetId ?? "?"} (confiança ${m.confidence.toFixed(2)}).`,
    entityType: "reconciliation_match",
    entityId: m.id,
    suggestedAction: "Revisar e usar confirm_match ou reject_match.",
  }));

  return makeResult(
    SKILL,
    ctx,
    {
      unreconciledCount: unreconciled.length,
      suggestedPendingCount: suggestedMatches.length,
      reconciledInMonthCount: reconciledInMonth.length,
      suggestions: suggestedMatches.map((m) => ({
        matchId: m.id,
        bankTransactionId: m.bankTransactionId,
        targetType: m.targetType,
        targetId: m.targetId,
        confidence: m.confidence,
      })),
      period: { start, end },
      formula:
        "não conciliadas = transações com reconciled=false (todas as contas); sugeridas pendentes = matches com status suggested; conciliadas no mês = transações reconciled=true com data dentro do mês corrente",
    },
    { pendingItems, confidence: 1.0, dataSources: DATA_SOURCES }
  );
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const conciliacaoSkill: SkillDefinition<ConciliacaoInput, ConciliacaoData> = {
  name: SKILL,
  responsibility:
    "Importar dados bancários (OFX/CSV; API bancária e Open Finance são mocks declarados), deduplicar transações, comparar extrato com contas a pagar/receber e pagamentos executados, conciliar automaticamente com grau de confiança, encaminhar divergências para revisão humana e manter o histórico de correspondências.",
  objective:
    "Garantir que toda transação bancária seja explicada — casada com um título ou pagamento, ou sinalizada para revisão — sem jamais movimentar dinheiro por conta própria.",
  inputSchema: conciliacaoInputSchema,
  consumes: ["statement.imported"],
  publishes: [
    "statement.imported",
    "reconciliation.auto_matched",
    "reconciliation.suggested",
    "reconciliation.confirmed",
    "reconciliation.rejected",
  ],
  dataSources: DATA_SOURCES,
  async execute(ctx, input) {
    switch (input.action) {
      case "import_statement":
        return importStatement(ctx, input);
      case "auto_match":
        return autoMatch(ctx, input);
      case "confirm_match":
        return confirmMatch(ctx, input);
      case "reject_match":
        return rejectMatch(ctx, input);
      case "reconciliation_status":
        return reconciliationStatus(ctx);
    }
  },
};
