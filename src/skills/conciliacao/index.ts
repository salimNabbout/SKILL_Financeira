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
import { persistAlert } from "@/core/alerts";
import { assertPermission } from "@/core/auth";
import { addDays, diffDays, endOfMonth, monthOf, startOfMonth, type ISODate } from "@/core/dates";
import type {
  AccountingEntry,
  BankTransaction,
  ID,
  Receipt,
  ReconciliationMatch,
  ReconciliationTargetType,
} from "@/core/entities";
// Plano de contas compartilhado com a skill contábil: a despesa bancária usa as
// MESMAS contas de despesa e caixa (ver applyBankFee).
import { ACCOUNT_CASH, ACCOUNT_DEFAULT_EXPENSE } from "@/skills/contabil";
import { NotFoundError, ValidationError } from "@/core/errors";
import { hashPayload } from "@/core/ids";
import { formatBRL, payableRemainingCents, receivableRemainingCents } from "@/core/money";
import { makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";
import { normalizeText, parseCnab240, parseCsvStatement, parseOfx } from "@/lib/importers";

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
  format: z.enum(["ofx", "csv", "cnab240"]),
  content: z.string().min(1),
});

const syncBankSchema = z.object({
  action: z.literal("sync_bank"),
  bankAccountId: z.string().min(1),
  sinceDays: z.number().int().min(1).max(90).optional(),
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
  syncBankSchema,
  autoMatchSchema,
  confirmMatchSchema,
  rejectMatchSchema,
  reconciliationStatusSchema,
]);

export type ImportStatementInput = z.infer<typeof importStatementSchema>;
export type SyncBankInput = z.infer<typeof syncBankSchema>;
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
  format: "ofx" | "csv" | "cnab240";
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
  /** Pares de transferência entre contas identificados nesta rodada. */
  transferPairs: number;
  /** Matches criados nesta rodada (auto-confirmados e sugeridos). */
  matches: ReconciliationMatch[];
  formula: string;
  /** Intervalo de datas das transações avaliadas (null se nenhuma). */
  period: { start: ISODate; end: ISODate } | null;
}

export interface ConfirmMatchData {
  match: ReconciliationMatch;
  /** Todos os matches do grupo quando a decisão envolve rateio/transferência. */
  matches?: ReconciliationMatch[];
  receipt?: Receipt;
  receipts?: Receipt[];
}

export interface RejectMatchData {
  match: ReconciliationMatch;
  /** Todos os matches do grupo quando a decisão envolve rateio/transferência. */
  matches?: ReconciliationMatch[];
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
    amountCents?: number;
    groupId?: ID;
    confidence: number;
  }>;
  period: { start: ISODate; end: ISODate };
  formula: string;
}

export interface SyncBankData {
  bankAccountId: ID;
  provider: string;
  importBatchId: string;
  period: { since: ISODate; until: ISODate };
  imported: number;
  duplicates: number;
  transactions: BankTransaction[];
}

export type ConciliacaoData =
  | ImportStatementData
  | SyncBankData
  | AutoMatchData
  | ConfirmMatchData
  | RejectMatchData
  | ReconciliationStatusData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Persiste alerta apenas se não houver outro ABERTO com mesmo code+entityId. */
async function persistAlertDeduped(ctx: SkillContext, alert: SkillAlert): Promise<void> {
  await persistAlert(ctx, alert, SKILL);
}

/** Arredonda a 2 casas para evitar ruído de ponto flutuante na soma dos pesos. */
function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

// Palavras que NÃO identificam a contraparte: sufixos societários e termos
// genéricos de razão social. Sem isso, "servicos" de "LIGHT SERVICOS DE
// ELETRICIDADE" casava com "TARIFA PACOTE SERVICOS" e virava falso positivo.
const NAME_STOPWORDS = new Set([
  // sufixos societários
  "ltda",
  "eireli",
  "epp",
  "cia",
  "sa",
  "mei",
  "me",
  // termos genéricos de razão social
  "servicos",
  "servico",
  "comercio",
  "comercial",
  "industria",
  "industrial",
  "brasil",
  "engenharia",
  "manutencao",
  "distribuidora",
  "consultoria",
  "tecnologia",
  "participacoes",
  "empreendimentos",
  "solucoes",
  "sistemas",
  "construtora",
  "transportes",
  "logistica",
]);

/**
 * Débito do próprio banco (tarifa, IOF, juros, encargo, cesta/pacote, anuidade):
 * não tem título a pagar do outro lado. Antes caía na baixa parcial e virava
 * falso positivo, ou ficava órfão em "não conciliadas".
 */
const BANK_FEE_RE =
  /\btarifa|\biof\b|\bjuros\b|\bencargo|\bcesta\b|\bpacote de servicos|\banuidade\b/;

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
    `casa se > 0,50; baixa automática se >= ${reconciliationAutoConfirmThreshold}. ` +
    `Fallbacks (nesta ordem): transferência entre contas (par oposto exato em outra conta = 0,55 ` +
    `+ data + palavra-chave transf/ted/doc +0,20); rateio 1 transação ↔ 2..4 parcelas da mesma ` +
    `contraparte com soma exata (0,55 + nome +0,20 + vencimentos na tolerância +0,15); baixa ` +
    `parcial sobre título maior (0,45 + nome obrigatório +0,20 + data) — parcial NUNCA é ` +
    `automática, sempre exige revisão humana e está DESATIVADA por padrão ` +
    `(config reconciliationEnablePartial${ctx.config.reconciliationEnablePartial ? " = true, ligada" : " = false"}); ` +
    `despesa bancária (tarifa/IOF/juros/encargo/cesta/pacote/anuidade em débito sem título) = 0,80, sempre sugestão.`
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
/**
 * Lança a DESPESA BANCÁRIA de uma tarifa conciliada. O app não tinha rota para
 * despesa sem título, então esta é a mínima: um lançamento contábil de ajuste
 * (débito em despesa operacional, crédito em caixa) usando o MESMO plano de
 * contas da skill contábil — nada de conta mágica duplicada.
 *
 * Idempotente pela origem (`fee:<txId>`): confirmar a mesma tarifa duas vezes
 * não lança duas despesas.
 */
async function applyBankFee(
  ctx: SkillContext,
  tx: BankTransaction,
  amountCents: number
): Promise<{ receipt?: Receipt; assumptions: string[] }> {
  if (tx.amountCents >= 0) {
    throw new ValidationError(
      `Transação ${tx.id} não é um débito; não pode ser lançada como despesa bancária.`
    );
  }
  const sourceId = `fee:${tx.id}`;
  const jaLancado = (await ctx.repos.accountingEntries.listAll(ctx.companyId)).some(
    (e) => e.sourceType === "adjustment" && e.sourceId === sourceId
  );
  if (jaLancado) {
    return {
      assumptions: [
        `Despesa bancária de ${formatBRL(amountCents)} já havia sido lançada para esta transação; nada foi duplicado.`,
      ],
    };
  }

  const entry: AccountingEntry = {
    id: ctx.ids.next("ae"),
    companyId: ctx.companyId,
    entryDate: tx.date,
    debitAccount: ACCOUNT_DEFAULT_EXPENSE,
    creditAccount: ACCOUNT_CASH,
    amountCents,
    memo: `Despesa bancária: ${tx.description}`,
    sourceType: "adjustment",
    sourceId,
    exported: false,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.repos.accountingEntries.create(entry);
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "accounting.entry_prepared",
    entityType: "accounting_entry",
    entityId: entry.id,
    after: entry,
    correlationId: ctx.correlationId,
  });

  return {
    assumptions: [
      `Despesa bancária de ${formatBRL(amountCents)} lançada (débito ${ACCOUNT_DEFAULT_EXPENSE}, crédito ${ACCOUNT_CASH}) — tarifa do próprio banco, sem título a pagar correspondente.`,
      "Classificação contábil da tarifa exige validação do contador (conta padrão de despesa operacional).",
    ],
  };
}

async function applySettlement(
  ctx: SkillContext,
  tx: BankTransaction,
  match: Pick<ReconciliationMatch, "targetType" | "targetId" | "amountCents">
): Promise<{ receipt?: Receipt; assumptions: string[] }> {
  // Despesa bancária não tem alvo de título: a baixa é o próprio lançamento
  // contábil da tarifa. Tratada ANTES do guarda de targetId, que existe para os
  // demais tipos.
  if (match.targetType === "bank_fee") {
    return applyBankFee(ctx, tx, match.amountCents ?? Math.abs(tx.amountCents));
  }
  if (!match.targetId) {
    throw new ValidationError("Conciliação sem alvo definido não pode ser aplicada.");
  }
  const nowIso = ctx.clock.now().toISOString();
  const assumptions: string[] = [];

  // Porção aplicada a ESTE alvo (baixa parcial/rateio); ausente = valor integral.
  const txAbs = Math.abs(tx.amountCents);
  const applied = match.amountCents ?? txAbs;
  if (applied <= 0 || applied > txAbs) {
    throw new ValidationError(
      `Porção inválida na conciliação: ${formatBRL(applied)} sobre transação de ${formatBRL(txAbs)}.`
    );
  }

  if (match.targetType === "transfer") {
    // Transferência entre contas: nenhuma receita/despesa — apenas marca o par.
    const other = await ctx.repos.bankTransactions.getById(ctx.companyId, match.targetId);
    if (!other) throw new NotFoundError("Transação contraparte", match.targetId);
    if (other.bankAccountId === tx.bankAccountId) {
      throw new ValidationError("Transferência exige transações em contas diferentes.");
    }
    if (other.amountCents !== -tx.amountCents) {
      throw new ValidationError(
        `Par de transferência inválido: valores não são opostos (${formatBRL(tx.amountCents)} vs ${formatBRL(other.amountCents)}).`
      );
    }
    if (!other.reconciled) await markTransactionReconciled(ctx, other);
    assumptions.push(
      "Transferência entre contas da própria empresa: as duas transações foram conciliadas entre si e NENHUMA receita ou despesa foi registrada."
    );
    return { assumptions };
  }

  if (match.targetType === "receivable") {
    if (tx.amountCents <= 0) {
      throw new ValidationError(
        `Transação ${tx.id} não é um crédito; não pode baixar título a receber.`
      );
    }
    const receivable = await ctx.repos.receivables.getById(ctx.companyId, match.targetId);
    if (!receivable) throw new NotFoundError("Título a receber", match.targetId);
    const remaining = receivableRemainingCents(receivable);
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
      amountCents: applied,
      receivedDate: tx.date,
      method: "transfer",
      registeredBy: "system",
      createdAt: nowIso,
    };
    await ctx.repos.receipts.create(receipt);
    const before = { ...receivable };
    receivable.receivedCents += applied;
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
    if (applied < remaining) {
      assumptions.push(
        `Baixa PARCIAL de ${formatBRL(applied)} no título ${receivable.id}; saldo restante de ${formatBRL(remaining - applied)} segue em aberto.`
      );
    } else if (applied !== remaining) {
      assumptions.push(
        `Diferença de ${formatBRL(Math.abs(applied - remaining))} entre o crédito bancário e o saldo do título ${receivable.id} absorvida dentro da tolerância configurada.`
      );
    }
    return { receipt, assumptions };
  }

  if (match.targetType === "payable") {
    if (tx.amountCents >= 0) {
      throw new ValidationError(`Transação ${tx.id} não é um débito; não pode baixar título a pagar.`);
    }
    const amount = applied;
    const payable = await ctx.repos.payables.getById(ctx.companyId, match.targetId);
    if (!payable) throw new NotFoundError("Título a pagar", match.targetId);
    const remaining = payableRemainingCents(payable);
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
    if (amount < remaining) {
      assumptions.push(
        `Baixa PARCIAL de ${formatBRL(amount)} no título ${payable.id}; saldo restante de ${formatBRL(remaining - amount)} segue em aberto.`
      );
    } else if (amount !== remaining) {
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

  const parsed =
    input.format === "ofx"
      ? parseOfx(input.content)
      : input.format === "cnab240"
        ? parseCnab240(input.content)
        : parseCsvStatement(input.content);
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

/**
 * Sincronização via porta BankDataProvider (Open Finance/agregador — MOCK no
 * MVP). Idempotente: externalId "sync:<provider>:<idNoProvedor>" deduplica;
 * sincronizar duas vezes o mesmo período não cria nada novo.
 */
async function syncBank(ctx: SkillContext, input: SyncBankInput): Promise<SkillResult<SyncBankData>> {
  assertPermission(ctx.actor, "reconciliation.manage");

  const account = await ctx.repos.bankAccounts.getById(ctx.companyId, input.bankAccountId);
  if (!account) throw new NotFoundError("Conta bancária", input.bankAccountId);
  if (!account.active) {
    throw new ValidationError(`Conta bancária inativa: ${account.name} (${account.id}).`);
  }

  const sinceDays = input.sinceDays ?? 30;
  const until = ctx.today();
  const since = addDays(until, -sinceDays);
  const provider = ctx.integrations.bankData;
  const external = await provider.listTransactions({
    bankAccountId: account.id,
    bankCode: account.bankCode,
    accountNumberMasked: account.accountNumberMasked,
    since,
    until,
  });

  const importBatchId = ctx.ids.next("imp");
  const nowIso = ctx.clock.now().toISOString();
  let duplicates = 0;
  const created: BankTransaction[] = [];
  for (const t of external) {
    const externalId = `sync:${provider.provider}:${t.providerTxId}`;
    const existing = await ctx.repos.bankTransactions.findByExternalId(
      ctx.companyId,
      account.id,
      externalId
    );
    if (existing) {
      duplicates++;
      continue;
    }
    const tx: BankTransaction = {
      id: ctx.ids.next("btx"),
      companyId: ctx.companyId,
      bankAccountId: account.id,
      date: t.date,
      amountCents: t.amountCents,
      currency: account.currency,
      description: t.description,
      externalId,
      importBatchId,
      source: "api_mock", // fonte de sincronização; provedores reais ganham source próprio na v1.2
      reconciled: false,
      createdAt: nowIso,
    };
    await ctx.repos.bankTransactions.create(tx);
    created.push(tx);
  }

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "statement.synced",
    entityType: "import_batch",
    entityId: importBatchId,
    after: {
      bankAccountId: account.id,
      provider: provider.provider,
      since,
      until,
      imported: created.length,
      duplicates,
      transactionIds: created.map((t) => t.id),
    },
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "statement.imported",
    payload: {
      bankAccountId: account.id,
      importBatchId,
      format: "sync",
      provider: provider.provider,
      imported: created.length,
      duplicates,
    },
    source: SKILL,
    correlationId: ctx.correlationId,
  });

  return makeResult(
    SKILL,
    ctx,
    {
      bankAccountId: account.id,
      provider: provider.provider,
      importBatchId,
      period: { since, until },
      imported: created.length,
      duplicates,
      transactions: created,
    },
    {
      assumptions: [
        `Transações obtidas pela porta de dados bancários "${provider.provider}" — no provedor mock o extrato é sintético e determinístico; Open Finance/agregador real entra na v1.2 com credenciais.`,
      ],
      confidence: 1.0,
      dataSources: [...DATA_SOURCES, "integration:bank_data"],
    }
  );
}

interface Candidate extends ScoreResult {
  targetType: "payable" | "receivable" | "payment";
  targetId: ID;
}

// Empate: pagamento executado tem prioridade sobre baixar o título de novo
// (evita dupla baixa quando o mesmo valor tem pagamento já registrado).
// Exaustivo sobre ReconciliationTargetType: os tipos que não disputam com um
// candidato de título (entram por caminho próprio) ficam no fim, e o mapa não
// quebra se alguém ampliar Candidate.
const TARGET_PRIORITY: Record<ReconciliationTargetType, number> = {
  payment: 0,
  payable: 1,
  receivable: 1,
  receipt: 1,
  transfer: 2,
  bank_fee: 3,
  unknown: 9,
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
  const pendingMatches = allMatches.filter((m) => m.status === "suggested");
  const pendingTxIds = new Set(pendingMatches.map((m) => m.bankTransactionId));
  // Par transação+alvo já rejeitado por humano não é sugerido novamente.
  const rejectedPairs = new Set(
    allMatches
      .filter((m) => m.status === "rejected" && m.targetId)
      .map((m) => `${m.bankTransactionId}|${m.targetId}`)
  );

  // Controle de saldo restante EM MEMÓRIA durante o lote: um título não pode
  // ser casado por duas transações além do saldo. O saldo inicial é clampado
  // em 0 (helper) — títulos sem saldo (≤0) não casam, e as subtrações abaixo
  // já usam Math.max(0, ...), então o pareamento não muda.
  const payableRemaining = new Map(payables.map((p) => [p.id, payableRemainingCents(p)]));
  const receivableRemaining = new Map(
    receivables.map((r) => [r.id, receivableRemainingCents(r)])
  );
  // Sugestões pendentes de rodadas anteriores também reservam saldo do alvo
  // (a porção do match, quando presente; senão o valor da transação).
  for (const m of pendingMatches) {
    if (!m.targetId) continue;
    let reserved = m.amountCents;
    if (reserved === undefined) {
      const pendingTx = await ctx.repos.bankTransactions.getById(ctx.companyId, m.bankTransactionId);
      reserved = pendingTx ? Math.abs(pendingTx.amountCents) : 0;
    }
    if (m.targetType === "payable" && payableRemaining.has(m.targetId)) {
      payableRemaining.set(m.targetId, Math.max(0, (payableRemaining.get(m.targetId) ?? 0) - reserved));
    } else if (m.targetType === "receivable" && receivableRemaining.has(m.targetId)) {
      receivableRemaining.set(
        m.targetId,
        Math.max(0, (receivableRemaining.get(m.targetId) ?? 0) - reserved)
      );
    }
  }

  let autoConfirmed = 0;
  let suggested = 0;
  let unmatched = 0;
  let skippedPending = 0;
  let transferPairs = 0;
  const matches: ReconciliationMatch[] = [];
  const alerts: SkillAlert[] = [];
  const pendingItems: PendingItem[] = [];
  const assumptions: string[] = [];

  // -------------------------------------------------------------------------
  // Fases de fallback (rodam quando o casamento 1↔1 exato não encontra alvo)
  // -------------------------------------------------------------------------
  const consumedTransfer = new Set<ID>();
  // IDs de transações que já receberam QUALQUER match ATIVO nesta rodada
  // (fase 1 exata, rateio, baixa parcial ou transferência). Uma transação já
  // casada não pode ser reusada como contraparte de transferência — do
  // contrário ficaria com dois matches ativos (ex.: payable + transfer),
  // explicando a mesma transação duas vezes.
  const matchedThisRound = new Set<ID>();
  const TRANSFER_KEYWORDS = /\btransf|\bted\b|\bdoc\b|entre contas/;

  async function createMatchRecord(
    tx: BankTransaction,
    data: Pick<ReconciliationMatch, "targetType" | "targetId" | "amountCents" | "groupId" | "confidence" | "notes">,
    isAuto: boolean
  ): Promise<ReconciliationMatch> {
    const nowIso = ctx.clock.now().toISOString();
    const match: ReconciliationMatch = {
      id: ctx.ids.next("rec"),
      companyId: ctx.companyId,
      bankTransactionId: tx.id,
      status: isAuto ? "auto_confirmed" : "suggested",
      matchedBy: "system",
      createdAt: nowIso,
      updatedAt: nowIso,
      ...data,
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
    // Marca a transação como já casada nesta rodada (evita reuso p/ transferência).
    matchedThisRound.add(match.bankTransactionId);
    matches.push(match);
    return match;
  }

  async function registerSuggestion(match: ReconciliationMatch, description: string): Promise<void> {
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "reconciliation.suggested",
      payload: {
        matchId: match.id,
        bankTransactionId: match.bankTransactionId,
        targetType: match.targetType,
        targetId: match.targetId,
        groupId: match.groupId,
        confidence: match.confidence,
        amountCents: match.amountCents,
      },
      source: SKILL,
      correlationId: ctx.correlationId,
    });
    pendingItems.push({
      code: "reconciliation_suggested",
      description,
      entityType: "reconciliation_match",
      entityId: match.id,
      suggestedAction: "Revisar e usar confirm_match ou reject_match.",
    });
    const alert: SkillAlert = {
      severity: "info",
      code: "reconciliation_review",
      message: `Sugestão de conciliação aguardando revisão humana: ${description}`,
      entityType: "reconciliation_match",
      entityId: match.id,
    };
    alerts.push(alert);
    await persistAlertDeduped(ctx, alert);
  }

  /**
   * Fase 2 — transferência entre contas: contraparte em OUTRA conta com valor
   * exatamente oposto e data dentro da tolerância.
   * Confiança: 0,55 (par oposto exato) + data (0,25 igual / 0,15 tolerância)
   * + 0,20 se alguma descrição contém palavra de transferência (transf/ted/doc).
   */
  async function tryTransferPair(tx: BankTransaction): Promise<boolean> {
    const counterparts = unreconciled
      .filter(
        (o) =>
          o.id !== tx.id &&
          o.bankAccountId !== tx.bankAccountId &&
          o.amountCents === -tx.amountCents &&
          // Já conciliada por outro caminho (rodada anterior) — não reusar.
          !o.reconciled &&
          // Já casada NESTA rodada (fase 1/rateio/parcial/transferência).
          !matchedThisRound.has(o.id) &&
          !consumedTransfer.has(o.id) &&
          !pendingTxIds.has(o.id) &&
          !rejectedPairs.has(`${tx.id}|${o.id}`) &&
          !rejectedPairs.has(`${o.id}|${tx.id}`) &&
          Math.abs(diffDays(o.date, tx.date)) <= ctx.config.reconciliationDateToleranceDays
      )
      .map((o) => {
        const dateDiff = Math.abs(diffDays(o.date, tx.date));
        const dateComponent = dateDiff === 0 ? 0.25 : 0.15;
        const keyword =
          TRANSFER_KEYWORDS.test(normalizeText(tx.description)) ||
          TRANSFER_KEYWORDS.test(normalizeText(o.description));
        const score = roundScore(0.55 + dateComponent + (keyword ? 0.2 : 0));
        return { other: o, dateDiff, score, keyword };
      })
      .sort((a, b) =>
        a.score !== b.score
          ? b.score - a.score
          : a.dateDiff !== b.dateDiff
            ? a.dateDiff - b.dateDiff
            : a.other.id < b.other.id
              ? -1
              : 1
      );
    const best = counterparts[0];
    if (!best) return false;

    const groupId = ctx.ids.next("grp");
    const isAuto = best.score >= ctx.config.reconciliationAutoConfirmThreshold;
    const notes =
      `transferência entre contas: par oposto exato=0,55; data=${best.dateDiff === 0 ? "0,25" : "0,15"} ` +
      `(${best.dateDiff} dia(s)); palavra-chave=${best.keyword ? "0,20" : "0,00"}`;
    const txAbs = Math.abs(tx.amountCents);
    const matchA = await createMatchRecord(
      tx,
      { targetType: "transfer", targetId: best.other.id, amountCents: txAbs, groupId, confidence: best.score, notes },
      isAuto
    );
    await createMatchRecord(
      best.other,
      { targetType: "transfer", targetId: tx.id, amountCents: txAbs, groupId, confidence: best.score, notes },
      isAuto
    );
    consumedTransfer.add(best.other.id);
    transferPairs++;

    if (isAuto) {
      const settlement = await applySettlement(ctx, tx, matchA); // marca a contraparte
      for (const a of settlement.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
      await markTransactionReconciled(ctx, tx);
      await ctx.events.publish({
        companyId: ctx.companyId,
        type: "reconciliation.auto_matched",
        payload: {
          groupId,
          bankTransactionIds: [tx.id, best.other.id],
          targetType: "transfer",
          confidence: best.score,
          amountCents: txAbs,
        },
        source: SKILL,
        correlationId: ctx.correlationId,
      });
      autoConfirmed++;
    } else {
      await registerSuggestion(
        matchA,
        `transferência entre contas ${formatBRL(txAbs)} (${tx.id} ↔ ${best.other.id}, confiança ${best.score.toFixed(2)}).`
      );
      suggested++;
    }
    return true;
  }

  /** Busca determinística de subconjunto (2..4 títulos) com soma EXATA. */
  function findExactSubset(
    items: Array<{ id: ID; remaining: number; dueDate: ISODate }>,
    target: number
  ): Array<{ id: ID; remaining: number; dueDate: ISODate }> | null {
    const sorted = [...items].sort((a, b) =>
      a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1
    );
    const pick: typeof sorted = [];
    function dfs(start: number, sum: number): boolean {
      if (sum === target && pick.length >= 2) return true;
      if (sum >= target || pick.length >= 4) return false;
      for (let i = start; i < sorted.length; i++) {
        pick.push(sorted[i]);
        if (dfs(i + 1, sum + sorted[i].remaining)) return true;
        pick.pop();
      }
      return false;
    }
    return dfs(0, 0) ? [...pick] : null;
  }

  /**
   * Fase 3 — rateio 1 transação ↔ N parcelas (2..4) da MESMA contraparte com
   * soma exata dos saldos. Confiança: 0,55 (soma exata) + 0,20 (nome na
   * descrição) + 0,15 (todos os vencimentos dentro da tolerância de dias).
   */
  async function tryInstallmentGroup(tx: BankTransaction): Promise<boolean> {
    const txAbs = Math.abs(tx.amountCents);
    const isCredit = tx.amountCents > 0;
    const byCounterparty = new Map<ID, Array<{ id: ID; remaining: number; dueDate: ISODate }>>();
    if (isCredit) {
      for (const r of receivables) {
        const remaining = receivableRemaining.get(r.id) ?? 0;
        if (remaining <= 0 || rejectedPairs.has(`${tx.id}|${r.id}`)) continue;
        const list = byCounterparty.get(r.customerId) ?? [];
        list.push({ id: r.id, remaining, dueDate: r.dueDate });
        byCounterparty.set(r.customerId, list);
      }
    } else {
      for (const p of payables) {
        const remaining = payableRemaining.get(p.id) ?? 0;
        if (remaining <= 0 || rejectedPairs.has(`${tx.id}|${p.id}`)) continue;
        const list = byCounterparty.get(p.supplierId) ?? [];
        list.push({ id: p.id, remaining, dueDate: p.dueDate });
        byCounterparty.set(p.supplierId, list);
      }
    }

    const description = normalizeText(tx.description);
    let best:
      | { counterpartyId: ID; subset: NonNullable<ReturnType<typeof findExactSubset>>; score: number; breakdown: string }
      | null = null;
    for (const counterpartyId of [...byCounterparty.keys()].sort()) {
      const subset = findExactSubset(byCounterparty.get(counterpartyId)!, txAbs);
      if (!subset) continue;
      const name = isCredit ? customers.get(counterpartyId) : suppliers.get(counterpartyId);
      const nameComponent = nameTokens(name).some((t) => description.includes(t)) ? 0.2 : 0;
      const allWithinDate = subset.every(
        (s) => Math.abs(diffDays(s.dueDate, tx.date)) <= ctx.config.reconciliationDateToleranceDays
      );
      const dateComponent = allWithinDate ? 0.15 : 0;
      const score = roundScore(0.55 + nameComponent + dateComponent);
      const breakdown =
        `rateio ${subset.length} parcela(s), soma exata=0,55; nome=${nameComponent.toFixed(2)}; ` +
        `vencimentos na tolerância=${dateComponent.toFixed(2)}`;
      if (!best || score > best.score) best = { counterpartyId, subset, score, breakdown };
    }
    if (!best) return false;

    const groupId = ctx.ids.next("grp");
    const isAuto = best.score >= ctx.config.reconciliationAutoConfirmThreshold;
    const targetType = isCredit ? ("receivable" as const) : ("payable" as const);
    const groupMatches: ReconciliationMatch[] = [];
    for (const item of best.subset) {
      groupMatches.push(
        await createMatchRecord(
          tx,
          { targetType, targetId: item.id, amountCents: item.remaining, groupId, confidence: best.score, notes: best.breakdown },
          isAuto
        )
      );
      const map = isCredit ? receivableRemaining : payableRemaining;
      map.set(item.id, Math.max(0, (map.get(item.id) ?? 0) - item.remaining));
    }

    if (isAuto) {
      for (const m of groupMatches) {
        const settlement = await applySettlement(ctx, tx, m);
        for (const a of settlement.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
      }
      await markTransactionReconciled(ctx, tx);
      await ctx.events.publish({
        companyId: ctx.companyId,
        type: "reconciliation.auto_matched",
        payload: {
          groupId,
          bankTransactionId: tx.id,
          targetType,
          targetIds: best.subset.map((s) => s.id),
          confidence: best.score,
          amountCents: txAbs,
        },
        source: SKILL,
        correlationId: ctx.correlationId,
      });
      autoConfirmed++;
    } else {
      await registerSuggestion(
        groupMatches[0],
        `rateio de ${formatBRL(txAbs)} entre ${best.subset.length} parcela(s) da mesma contraparte (confiança ${best.score.toFixed(2)}).`
      );
      suggested++;
    }
    return true;
  }

  /**
   * Fase 4 — baixa parcial: transação MENOR que o saldo de um único título da
   * contraparte. Exige o nome da contraparte na descrição e NUNCA é automática
   * (baixa parcial sempre passa por revisão humana — política declarada).
   * Confiança: 0,45 (parcial) + 0,20 (nome, obrigatório) + data (0,25/0,15).
   */
  async function tryPartialSuggestion(tx: BankTransaction): Promise<boolean> {
    const txAbs = Math.abs(tx.amountCents);
    const isCredit = tx.amountCents > 0;
    const description = normalizeText(tx.description);
    const tolerance = ctx.config.reconciliationAmountToleranceCents;

    interface PartialCandidate {
      targetId: ID;
      score: number;
      dateDiff: number;
      breakdown: string;
    }
    const found: PartialCandidate[] = [];
    const pool = isCredit
      ? receivables.map((r) => ({
          id: r.id,
          remaining: receivableRemaining.get(r.id) ?? 0,
          dueDate: r.dueDate,
          name: customers.get(r.customerId),
        }))
      : payables.map((p) => ({
          id: p.id,
          remaining: payableRemaining.get(p.id) ?? 0,
          dueDate: p.dueDate,
          name: suppliers.get(p.supplierId),
        }));
    for (const item of pool) {
      if (item.remaining <= txAbs + tolerance) continue; // não é parcial (fase 1 cobre)
      if (rejectedPairs.has(`${tx.id}|${item.id}`)) continue;
      // A data precisa estar DENTRO da tolerância: antes, um vencimento 77 dias
      // longe pontuava 0,00 em data e a sugestão nascia mesmo assim.
      const dateDiff = Math.abs(diffDays(item.dueDate, tx.date));
      if (dateDiff > ctx.config.reconciliationDateToleranceDays) continue;
      // Um token genérico não identifica a contraparte. Exige-se DOIS tokens do
      // nome na descrição, ou um único suficientemente específico (>= 6 letras).
      const tokens = nameTokens(item.name).filter((t) => description.includes(t));
      const especifico = tokens.find((t) => t.length >= 6);
      if (tokens.length < 2 && !especifico) continue;
      const evidencia = tokens.length >= 2 ? tokens.slice(0, 2).join('", "') : (especifico as string);
      const dateComponent = dateDiff === 0 ? 0.25 : 0.15;
      found.push({
        targetId: item.id,
        score: roundScore(0.45 + 0.2 + dateComponent),
        dateDiff,
        breakdown:
          `baixa parcial=0,45; nome=0,20 ("${evidencia}"); data=${dateComponent.toFixed(2)} (${dateDiff} dia(s)); ` +
          `porção ${formatBRL(txAbs)} sobre saldo maior`,
      });
    }
    if (found.length === 0) return false;
    found.sort((a, b) =>
      a.score !== b.score
        ? b.score - a.score
        : a.dateDiff !== b.dateDiff
          ? a.dateDiff - b.dateDiff
          : a.targetId < b.targetId
            ? -1
            : 1
    );
    const best = found[0];
    const targetType = isCredit ? ("receivable" as const) : ("payable" as const);

    const match = await createMatchRecord(
      tx,
      { targetType, targetId: best.targetId, amountCents: txAbs, groupId: undefined, confidence: best.score, notes: best.breakdown },
      false // parcial NUNCA é automática
    );
    const map = isCredit ? receivableRemaining : payableRemaining;
    map.set(best.targetId, Math.max(0, (map.get(best.targetId) ?? 0) - txAbs));
    await registerSuggestion(
      match,
      `baixa PARCIAL de ${formatBRL(txAbs)} no ${targetType} ${best.targetId} (confiança ${best.score.toFixed(2)}; sempre exige revisão humana).`
    );
    suggested++;
    return true;
  }

  /**
   * Despesa bancária: débito de tarifa/IOF/juros/encargo/cesta/pacote/anuidade,
   * que não tem título a pagar do outro lado. Sugestão (nunca automática) com
   * alvo próprio `bank_fee` — sem alvo de título, portanto sem `targetId`.
   * Roda ANTES dos demais fallbacks: um débito assim não é transferência, nem
   * rateio, nem baixa parcial de título de fornecedor.
   */
  async function tryBankFeeSuggestion(tx: BankTransaction): Promise<boolean> {
    if (tx.amountCents >= 0) return false;
    const description = normalizeText(tx.description);
    const hit = BANK_FEE_RE.exec(description);
    if (!hit) return false;

    const match = await createMatchRecord(
      tx,
      {
        targetType: "bank_fee",
        targetId: undefined,
        amountCents: Math.abs(tx.amountCents),
        groupId: undefined,
        confidence: 0.8,
        notes: `despesa bancária: palavra-chave "${hit[0].trim()}"=0,80`,
      },
      false // despesa bancária NUNCA é automática
    );
    await registerSuggestion(
      match,
      `despesa bancária de ${formatBRL(Math.abs(tx.amountCents))} ("${tx.description}") sem título a pagar correspondente (confiança 0,80).`
    );
    suggested++;
    return true;
  }

  for (const tx of txs) {
    if (pendingTxIds.has(tx.id)) {
      skippedPending++;
      continue;
    }
    if (consumedTransfer.has(tx.id)) continue; // contraparte já pareada nesta rodada
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
      // Fases de fallback, nesta ordem: despesa bancária → transferência entre
      // contas → rateio multi-parcela → baixa parcial (esta só com a flag
      // reconciliationEnablePartial ligada; ver o comentário da config).
      if (await tryBankFeeSuggestion(tx)) continue;
      if (await tryTransferPair(tx)) continue;
      if (await tryInstallmentGroup(tx)) continue;
      if (ctx.config.reconciliationEnablePartial && (await tryPartialSuggestion(tx))) continue;
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
      amountCents: txAbs,
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
    // Casada nesta rodada (fase 1 exata): não reusar como par de transferência.
    matchedThisRound.add(tx.id);

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
      transferPairs,
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

/** Carrega o grupo do match (rateio/transferência) ou [match] quando avulso. */
async function loadMatchGroup(
  ctx: SkillContext,
  match: ReconciliationMatch
): Promise<ReconciliationMatch[]> {
  if (!match.groupId) return [match];
  const group = (await ctx.repos.reconciliations.listAll(ctx.companyId))
    .filter((m) => m.groupId === match.groupId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return group.length > 0 ? group : [match];
}

async function confirmMatch(
  ctx: SkillContext,
  input: ConfirmMatchInput
): Promise<SkillResult<ConfirmMatchData>> {
  assertPermission(ctx.actor, "reconciliation.manage");

  const match = await ctx.repos.reconciliations.getById(ctx.companyId, input.matchId);
  if (!match) throw new NotFoundError("Conciliação", input.matchId);
  // Rateios e transferências são decididos EM CONJUNTO: confirmar um match do
  // grupo aplica o grupo inteiro (as porções somam a transação).
  const group = await loadMatchGroup(ctx, match);

  const applied = (s: ReconciliationMatch["status"]) => s === "confirmed" || s === "auto_confirmed";
  if (group.every((m) => applied(m.status))) {
    return makeResult(
      SKILL,
      ctx,
      { match, matches: group.length > 1 ? group : undefined },
      {
        assumptions: [
          `Conciliação ${match.id}${match.groupId ? ` (grupo ${match.groupId})` : ""} já estava aplicada; confirmação idempotente sem novo efeito.`,
        ],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (group.some((m) => m.status === "rejected") || group.some((m) => applied(m.status))) {
    throw new ValidationError(
      `Conciliação ${match.id}${match.groupId ? ` (grupo ${match.groupId})` : ""} está em estado misto/rejeitado; execute auto_match novamente para gerar nova sugestão.`
    );
  }

  const txIds = [...new Set(group.map((m) => m.bankTransactionId))];
  const txById = new Map<ID, BankTransaction>();
  for (const id of txIds) {
    const tx = await ctx.repos.bankTransactions.getById(ctx.companyId, id);
    if (!tx) throw new NotFoundError("Transação bancária", id);
    if (tx.reconciled) {
      throw new ValidationError(`Transação ${tx.id} já está conciliada por outro caminho.`);
    }
    txById.set(id, tx);
  }

  const assumptions: string[] = [];
  const receipts: Receipt[] = [];
  if (match.targetType === "transfer") {
    // Par de transferência: aplica uma vez (marca a contraparte) e o próprio tx.
    const first = group[0];
    const firstTx = txById.get(first.bankTransactionId)!;
    const settlement = await applySettlement(ctx, firstTx, first);
    assumptions.push(...settlement.assumptions);
    await markTransactionReconciled(ctx, firstTx);
  } else {
    const tx = txById.get(match.bankTransactionId)!;
    for (const m of group) {
      const settlement = await applySettlement(ctx, tx, m);
      if (settlement.receipt) receipts.push(settlement.receipt);
      for (const a of settlement.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
    }
    await markTransactionReconciled(ctx, tx);
  }

  const nowIso = ctx.clock.now().toISOString();
  for (const m of group) {
    const before = { ...m };
    m.status = "confirmed";
    m.matchedBy = ctx.actor.id;
    m.updatedAt = nowIso;
    await ctx.repos.reconciliations.update(m);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "reconciliation.confirmed",
      entityType: "reconciliation_match",
      entityId: m.id,
      before,
      after: m,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "reconciliation.confirmed",
      payload: {
        matchId: m.id,
        groupId: m.groupId,
        bankTransactionId: m.bankTransactionId,
        targetType: m.targetType,
        targetId: m.targetId,
        amountCents: m.amountCents,
        confidence: m.confidence,
        confirmedBy: ctx.actor.id,
      },
      source: SKILL,
      correlationId: ctx.correlationId,
    });
  }

  const confirmed = group.find((m) => m.id === match.id) ?? group[0];
  return makeResult(
    SKILL,
    ctx,
    {
      match: confirmed,
      matches: group.length > 1 ? group : undefined,
      receipt: receipts[0],
      receipts: receipts.length > 0 ? receipts : undefined,
    },
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
  // Rejeitar um match de grupo rejeita o grupo inteiro (rateio/transferência).
  const group = await loadMatchGroup(ctx, match);

  if (group.every((m) => m.status === "rejected")) {
    return makeResult(
      SKILL,
      ctx,
      { match, matches: group.length > 1 ? group : undefined },
      {
        assumptions: [`Conciliação ${match.id} já estava rejeitada; rejeição idempotente sem novo efeito.`],
        dataSources: DATA_SOURCES,
      }
    );
  }
  if (group.some((m) => m.status !== "suggested" && m.status !== "rejected")) {
    throw new ValidationError(
      `Conciliação ${match.id} já foi aplicada; estorno não é suportado no MVP.`
    );
  }

  const nowIso = ctx.clock.now().toISOString();
  for (const m of group) {
    if (m.status === "rejected") continue;
    const before = { ...m };
    m.status = "rejected";
    m.matchedBy = ctx.actor.id;
    if (input.notes) m.notes = input.notes;
    m.updatedAt = nowIso;
    await ctx.repos.reconciliations.update(m);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "reconciliation.rejected",
      entityType: "reconciliation_match",
      entityId: m.id,
      before,
      after: m,
      correlationId: ctx.correlationId,
    });
    await ctx.events.publish({
      companyId: ctx.companyId,
      type: "reconciliation.rejected",
      payload: {
        matchId: m.id,
        groupId: m.groupId,
        bankTransactionId: m.bankTransactionId,
        targetType: m.targetType,
        targetId: m.targetId,
        rejectedBy: ctx.actor.id,
        notes: input.notes,
      },
      source: SKILL,
      correlationId: ctx.correlationId,
    });
  }

  // Defensivo: sugestão nunca concilia a transação, mas garantimos o estado.
  for (const txId of new Set(group.map((m) => m.bankTransactionId))) {
    const tx = await ctx.repos.bankTransactions.getById(ctx.companyId, txId);
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
  }

  const rejected = group.find((m) => m.id === match.id) ?? group[0];
  return makeResult(
    SKILL,
    ctx,
    { match: rejected, matches: group.length > 1 ? group : undefined },
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
        amountCents: m.amountCents,
        groupId: m.groupId,
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
      case "sync_bank":
        return syncBank(ctx, input);
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
