/**
 * Unificação dos lançamentos de caixa — o equivalente da `vw_fc_lancamento`
 * da especificação, como função de domínio PURA (sem banco, sem framework):
 * serve o adaptador em memória (demo e testes) e o Prisma da mesma forma, e
 * produz o mesmo resultado para a mesma entrada (idempotente por construção).
 *
 * Fontes, em ordem de precedência:
 *  1. Movimento bancário com conciliação CONFIRMADA (`confirmed` ou
 *     `auto_confirmed`) → REALIZADO pela conciliação; data de caixa = data do
 *     movimento. O pagamento/recebimento alvo é consumido para não somar de
 *     novo. Transferência entre contas próprias (alvo `transfer`, ou par
 *     espelhado: mesmo valor, contas próprias, ±1 dia) é neutra: sai da view.
 *  2. Movimento bancário SEM conciliação explícita que casa com um pagamento
 *     executado / recebimento registrado (mesma conta, mesmo valor, ±3 dias)
 *     → uma linha só, realizada, com o critério registrado em `matchCriteria`.
 *  3. Pagamento executado / recebimento registrado sem conciliação → decisão
 *     A da Fase 0: REALIZADO com `realizedBy = "baixa_app"` (padrão) ou, no
 *     modo estrito (`realizedFallback: false`), PREVISTO.
 *  4. Título a pagar/receber em aberto (saldo restante) → PREVISTO na data de
 *     vencimento (ou na data agendada do pagamento pendente, se houver).
 *  5. Ajuste manual → como registrado.
 *
 * Excluídos (com o motivo, em `excluded`): títulos e baixas cancelados,
 * transações `api_mock`, transferências internas, títulos mapeados para a
 * categoria neutra e movimentos bancários sem conciliação nem casamento (eles
 * são pendência da Conciliação, não lançamento do fluxo).
 *
 * Categoria: resolvida pelo de-para (`fc_mapeamento`), nesta ordem — plano
 * contábil (id da Category do título) → categoria de fornecedor (texto) ou
 * categoria a receber (id) → regra por texto na descrição (menor `priority`
 * primeiro). Sem regra → `a_classificar`. Tarifa do próprio banco (match
 * `bank_fee`) → `tarifas_bancarias` (classificação explícita da conciliação,
 * não semelhança). Nunca se inventa categoria.
 *
 * Mês/ano do lançamento = DATA DE CAIXA (regime de caixa): realizado pela data
 * do movimento/baixa, previsto pelo vencimento. A data de competência (emissão
 * do título) sai junto, só para consulta.
 */

import { addDays, monthOf, todayInTz, type ISODate } from "@/core/dates";
import type {
  BankAccount,
  BankTransaction,
  CashflowCategory,
  CashflowEntry,
  CashflowGroup,
  CashflowManualEntry,
  CashflowMapping,
  CashflowMappingSource,
  ID,
  Payable,
  Payment,
  Receipt,
  Receivable,
  ReconciliationMatch,
} from "@/core/entities";
import { receiptIsActive } from "@/core/money";
import {
  CASHFLOW_BANK_FEE_ID,
  CASHFLOW_TRANSFER_ID,
  CASHFLOW_UNCLASSIFIED_ID,
} from "./plan";

export interface UnifyOptions {
  /** Decisão A: pagamento/recebimento baixado no app sem conciliação conta
   *  como realizado (`baixa_app`). `false` = modo estrito (vira previsto). */
  realizedFallback?: boolean;
  /** Janela do casamento implícito movimento × baixa (dias). Padrão 3. */
  implicitMatchWindowDays?: number;
  /** Janela do par espelhado de transferência (dias). Padrão 1. */
  transferWindowDays?: number;
}

export interface UnifyInput {
  timeZone: string;
  payables: Payable[];
  payments: Payment[];
  receivables: Receivable[];
  receipts: Receipt[];
  bankAccounts: BankAccount[];
  bankTransactions: BankTransaction[];
  matches: ReconciliationMatch[];
  manualEntries: CashflowManualEntry[];
  mappings: CashflowMapping[];
  categories: CashflowCategory[];
  options?: UnifyOptions;
}

export type ExclusionReason =
  | "cancelado"
  | "extrato_mock"
  | "transferencia_interna"
  | "sem_conciliacao"
  | "categoria_neutra"
  | "sem_movimento";

export interface UnifyExclusion {
  reason: ExclusionReason;
  origin: CashflowEntry["origin"];
  originId: ID;
  amountCents: number;
  /** Critério que levou à exclusão (ex.: "par espelhado ±1 dia"). */
  criteria?: string;
}

export interface UnifyResult {
  entries: CashflowEntry[];
  excluded: UnifyExclusion[];
}

const CONFIRMED = new Set(["confirmed", "auto_confirmed"]);

/** Chave de texto do de-para: minúsculas, sem acento, espaços colapsados. */
export function normalizeKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

interface Resolved {
  categoryId: ID;
  mappingSource: CashflowEntry["mappingSource"];
}

function buildResolver(mappings: CashflowMapping[], categories: CashflowCategory[]) {
  const active = mappings.filter((m) => m.active);
  const known = new Set(categories.map((c) => c.id));
  const byExact = new Map<string, CashflowMapping>();
  for (const m of active) {
    if (m.source === "regra_texto") continue;
    byExact.set(`${m.source}:${normalizeKey(m.sourceKey)}`, m);
  }
  const textRules = active
    .filter((m) => m.source === "regra_texto" && m.sourceKey.trim() !== "")
    .map((m) => ({ ...m, key: normalizeKey(m.sourceKey) }))
    // Menor priority primeiro; empate pela chave mais longa (mais específica),
    // depois pelo id — ordem total, para o resultado não depender da entrada.
    .sort((a, b) => a.priority - b.priority || b.key.length - a.key.length || a.id.localeCompare(b.id));

  const pick = (m: CashflowMapping | undefined, source: CashflowMappingSource): Resolved | null =>
    m && known.has(m.categoryId) ? { categoryId: m.categoryId, mappingSource: source } : null;

  return {
    exact(source: CashflowMappingSource, key: string | undefined): Resolved | null {
      if (!key) return null;
      return pick(byExact.get(`${source}:${normalizeKey(key)}`), source);
    },
    text(description: string): Resolved | null {
      const norm = normalizeKey(description);
      for (const rule of textRules) {
        if (norm.includes(rule.key)) return pick(rule, "regra_texto");
      }
      return null;
    },
    unclassified(): Resolved {
      return { categoryId: CASHFLOW_UNCLASSIFIED_ID, mappingSource: "nao_mapeado" };
    },
  };
}

export function unifyCashflow(input: UnifyInput): UnifyResult {
  const opts = {
    realizedFallback: input.options?.realizedFallback ?? true,
    implicitMatchWindowDays: input.options?.implicitMatchWindowDays ?? 3,
    transferWindowDays: input.options?.transferWindowDays ?? 1,
  };
  const resolver = buildResolver(input.mappings, input.categories);
  const groupOf = new Map<ID, CashflowGroup>(input.categories.map((c) => [c.id, c.group]));
  const payableById = new Map(input.payables.map((p) => [p.id, p]));
  const paymentById = new Map(input.payments.map((p) => [p.id, p]));
  const receivableById = new Map(input.receivables.map((r) => [r.id, r]));
  const receiptById = new Map(input.receipts.map((r) => [r.id, r]));
  const ownAccounts = new Set(input.bankAccounts.map((a) => a.id));

  const entries: CashflowEntry[] = [];
  const excluded: UnifyExclusion[] = [];
  const consumedPayments = new Set<ID>();
  const consumedReceipts = new Set<ID>();

  type Keys = CashflowEntry["mappingKeys"];
  const keysOfPayable = (p: Payable): Keys => [
    ...(p.categoryId ? [{ source: "plano_contas" as const, sourceKey: p.categoryId }] : []),
    ...(p.supplierCategory ? [{ source: "categoria_ap" as const, sourceKey: p.supplierCategory }] : []),
    { source: "regra_texto" as const, sourceKey: p.description },
  ];
  const keysOfReceivable = (r: Receivable): Keys => [
    ...(r.categoryId ? [{ source: "categoria_ar" as const, sourceKey: r.categoryId }] : []),
    { source: "regra_texto" as const, sourceKey: r.description },
  ];
  const keysOfText = (description: string): Keys => [{ source: "regra_texto" as const, sourceKey: description }];

  const categoryOfPayable = (p: Payable): Resolved & { mappingKeys: Keys } => ({
    ...(resolver.exact("plano_contas", p.categoryId) ??
      resolver.exact("categoria_ap", p.supplierCategory) ??
      resolver.text(p.description) ??
      resolver.unclassified()),
    mappingKeys: keysOfPayable(p),
  });
  const categoryOfReceivable = (r: Receivable): Resolved & { mappingKeys: Keys } => ({
    ...(resolver.exact("categoria_ar", r.categoryId) ?? resolver.text(r.description) ?? resolver.unclassified()),
    mappingKeys: keysOfReceivable(r),
  });
  const categoryOfText = (description: string): Resolved & { mappingKeys: Keys } => ({
    ...(resolver.text(description) ?? resolver.unclassified()),
    mappingKeys: keysOfText(description),
  });

  const push = (
    e: Omit<CashflowEntry, "month" | "year" | "group"> & { group?: CashflowGroup }
  ): void => {
    if (e.categoryId === CASHFLOW_TRANSFER_ID) {
      excluded.push({
        reason: "categoria_neutra",
        origin: e.origin,
        originId: e.originId,
        amountCents: e.amountCents,
        criteria: "mapeado para transferencia_interna",
      });
      return;
    }
    if (e.amountCents <= 0) return;
    entries.push({
      ...e,
      group: e.group ?? groupOf.get(e.categoryId) ?? "outras",
      month: Number(e.cashDate.slice(5, 7)),
      year: Number(e.cashDate.slice(0, 4)),
    });
  };

  // ---------------------------------------------------------------- 1. conciliação confirmada
  const eligibleTx: BankTransaction[] = [];
  for (const tx of input.bankTransactions) {
    if (tx.source === "api_mock") {
      excluded.push({ reason: "extrato_mock", origin: "conciliacao", originId: tx.id, amountCents: Math.abs(tx.amountCents) });
      continue;
    }
    if (!ownAccounts.has(tx.bankAccountId)) continue;
    eligibleTx.push(tx);
  }
  const matchesByTx = new Map<ID, ReconciliationMatch[]>();
  for (const m of input.matches) {
    if (!CONFIRMED.has(m.status)) continue;
    const list = matchesByTx.get(m.bankTransactionId) ?? [];
    list.push(m);
    matchesByTx.set(m.bankTransactionId, list);
  }

  const unmatched: BankTransaction[] = [];
  for (const tx of eligibleTx) {
    const matches = matchesByTx.get(tx.id);
    if (!matches || matches.length === 0) {
      unmatched.push(tx);
      continue;
    }
    const kind: CashflowEntry["kind"] = tx.amountCents >= 0 ? "entrada" : "saida";
    for (const m of matches.sort((a, b) => a.id.localeCompare(b.id))) {
      const amount = m.amountCents ?? Math.abs(tx.amountCents);
      const base = {
        cashDate: tx.date,
        kind,
        bankAccountId: tx.bankAccountId,
        status: "realizado" as const,
        realizedBy: "conciliacao" as const,
        amountCents: amount,
        origin: "conciliacao" as const,
        originId: tx.id,
        matchCriteria: `conciliação ${m.status} (${m.targetType})`,
      };
      switch (m.targetType) {
        case "transfer":
          excluded.push({ reason: "transferencia_interna", origin: "conciliacao", originId: tx.id, amountCents: amount, criteria: "conciliação: par de transferência" });
          break;
        case "bank_fee":
          push({ ...base, competenceDate: tx.date, categoryId: CASHFLOW_BANK_FEE_ID, mappingSource: "conciliacao_bank_fee", description: tx.description });
          break;
        case "payment": {
          const pay = m.targetId ? paymentById.get(m.targetId) : undefined;
          const payable = pay ? payableById.get(pay.payableId) : undefined;
          if (pay) consumedPayments.add(pay.id);
          const cat = payable ? categoryOfPayable(payable) : categoryOfText(tx.description);
          push({ ...base, competenceDate: payable?.issueDate ?? tx.date, categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: payable?.description ?? tx.description, costCenterId: payable?.costCenterId });
          break;
        }
        case "payable": {
          const payable = m.targetId ? payableById.get(m.targetId) : undefined;
          const cat = payable ? categoryOfPayable(payable) : categoryOfText(tx.description);
          push({ ...base, competenceDate: payable?.issueDate ?? tx.date, categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: payable?.description ?? tx.description, costCenterId: payable?.costCenterId });
          break;
        }
        case "receipt": {
          const rec = m.targetId ? receiptById.get(m.targetId) : undefined;
          const receivable = rec ? receivableById.get(rec.receivableId) : undefined;
          if (rec) consumedReceipts.add(rec.id);
          const cat = receivable ? categoryOfReceivable(receivable) : categoryOfText(tx.description);
          push({ ...base, competenceDate: receivable?.issueDate ?? tx.date, categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: receivable?.description ?? tx.description, costCenterId: receivable?.costCenterId });
          break;
        }
        case "receivable": {
          const receivable = m.targetId ? receivableById.get(m.targetId) : undefined;
          const cat = receivable ? categoryOfReceivable(receivable) : categoryOfText(tx.description);
          push({ ...base, competenceDate: receivable?.issueDate ?? tx.date, categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: receivable?.description ?? tx.description, costCenterId: receivable?.costCenterId });
          break;
        }
        default: {
          const cat = categoryOfText(tx.description);
          push({ ...base, competenceDate: tx.date, categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: tx.description });
        }
      }
    }
  }

  // ---------------------------------------------------------------- 1b. par espelhado de transferência
  const paired = new Set<ID>();
  const sortedUnmatched = [...unmatched].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const tx of sortedUnmatched) {
    if (paired.has(tx.id) || tx.amountCents >= 0) continue;
    const mirror = sortedUnmatched.find(
      (o) =>
        !paired.has(o.id) &&
        o.id !== tx.id &&
        o.bankAccountId !== tx.bankAccountId &&
        o.amountCents === -tx.amountCents &&
        Math.abs(daysBetween(o.date, tx.date)) <= opts.transferWindowDays
    );
    if (!mirror) continue;
    paired.add(tx.id);
    paired.add(mirror.id);
    const criteria = `par espelhado: mesmo valor, contas próprias, ±${opts.transferWindowDays} dia(s)`;
    excluded.push({ reason: "transferencia_interna", origin: "conciliacao", originId: tx.id, amountCents: Math.abs(tx.amountCents), criteria });
    excluded.push({ reason: "transferencia_interna", origin: "conciliacao", originId: mirror.id, amountCents: mirror.amountCents, criteria });
  }

  // ---------------------------------------------------------------- 2. casamento implícito (valor + data + conta)
  const executedPayments = input.payments.filter((p) => p.status === "executed" && p.executedAt);
  const activeReceipts = input.receipts.filter(receiptIsActive);
  const paymentDate = (p: Payment): ISODate => todayInTz(new Date(p.executedAt as string), input.timeZone);
  const criteriaImplicit = `casamento implícito: mesma conta, mesmo valor, ±${opts.implicitMatchWindowDays} dia(s)`;

  for (const tx of sortedUnmatched) {
    if (paired.has(tx.id)) continue;
    if (tx.amountCents < 0) {
      const pay = executedPayments
        .filter((p) => !consumedPayments.has(p.id) && p.bankAccountId === tx.bankAccountId && p.amountCents === -tx.amountCents)
        .filter((p) => Math.abs(daysBetween(paymentDate(p), tx.date)) <= opts.implicitMatchWindowDays)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (pay) {
        consumedPayments.add(pay.id);
        const payable = payableById.get(pay.payableId);
        const cat = payable ? categoryOfPayable(payable) : categoryOfText(tx.description);
        push({ cashDate: tx.date, competenceDate: payable?.issueDate ?? tx.date, kind: "saida", categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: payable?.description ?? tx.description, costCenterId: payable?.costCenterId, bankAccountId: tx.bankAccountId, status: "realizado", realizedBy: "conciliacao", amountCents: -tx.amountCents, origin: "conciliacao", originId: tx.id, matchCriteria: criteriaImplicit });
        continue;
      }
    } else {
      const rec = activeReceipts
        .filter((r) => !consumedReceipts.has(r.id) && r.bankAccountId === tx.bankAccountId && r.amountCents === tx.amountCents)
        .filter((r) => Math.abs(daysBetween(r.receivedDate, tx.date)) <= opts.implicitMatchWindowDays)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (rec) {
        consumedReceipts.add(rec.id);
        const receivable = receivableById.get(rec.receivableId);
        const cat = receivable ? categoryOfReceivable(receivable) : categoryOfText(tx.description);
        push({ cashDate: tx.date, competenceDate: receivable?.issueDate ?? tx.date, kind: "entrada", categoryId: cat.categoryId, mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys, description: receivable?.description ?? tx.description, costCenterId: receivable?.costCenterId, bankAccountId: tx.bankAccountId, status: "realizado", realizedBy: "conciliacao", amountCents: tx.amountCents, origin: "conciliacao", originId: tx.id, matchCriteria: criteriaImplicit });
        continue;
      }
    }
    // Sem conciliação nem casamento: pendência da Conciliação, não do fluxo.
    excluded.push({ reason: "sem_conciliacao", origin: "conciliacao", originId: tx.id, amountCents: Math.abs(tx.amountCents) });
  }

  // ---------------------------------------------------------------- 3. baixas no app sem conciliação
  for (const pay of executedPayments.sort((a, b) => a.id.localeCompare(b.id))) {
    if (consumedPayments.has(pay.id)) continue;
    const payable = payableById.get(pay.payableId);
    if (!payable || payable.status === "canceled") {
      excluded.push({ reason: "cancelado", origin: "contas_pagar", originId: pay.id, amountCents: pay.amountCents });
      continue;
    }
    const cat = categoryOfPayable(payable);
    push({
      cashDate: paymentDate(pay),
      competenceDate: payable.issueDate,
      kind: "saida",
      categoryId: cat.categoryId,
      mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys,
      description: payable.description,
      costCenterId: payable.costCenterId,
      bankAccountId: pay.bankAccountId,
      status: opts.realizedFallback ? "realizado" : "previsto",
      realizedBy: opts.realizedFallback ? "baixa_app" : undefined,
      amountCents: pay.amountCents,
      origin: "contas_pagar",
      originId: pay.id,
      parentId: payable.id,
      matchCriteria: opts.realizedFallback ? "baixa no app sem conciliação (fallback declarado)" : "baixa no app sem conciliação: previsto (modo estrito)",
    });
  }
  for (const rec of activeReceipts.sort((a, b) => a.id.localeCompare(b.id))) {
    if (consumedReceipts.has(rec.id)) continue;
    const receivable = receivableById.get(rec.receivableId);
    if (!receivable || receivable.status === "canceled") {
      excluded.push({ reason: "cancelado", origin: "contas_receber", originId: rec.id, amountCents: rec.amountCents });
      continue;
    }
    const cat = categoryOfReceivable(receivable);
    push({
      cashDate: rec.receivedDate,
      competenceDate: receivable.issueDate,
      kind: "entrada",
      categoryId: cat.categoryId,
      mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys,
      description: receivable.description,
      costCenterId: receivable.costCenterId,
      bankAccountId: rec.bankAccountId,
      status: opts.realizedFallback ? "realizado" : "previsto",
      realizedBy: opts.realizedFallback ? "baixa_app" : undefined,
      amountCents: rec.amountCents,
      origin: "contas_receber",
      originId: rec.id,
      parentId: receivable.id,
      matchCriteria: opts.realizedFallback ? "baixa no app sem conciliação (fallback declarado)" : "baixa no app sem conciliação: previsto (modo estrito)",
    });
  }

  // ---------------------------------------------------------------- 4. títulos em aberto → previsto (saldo restante)
  const pendingByPayable = new Map<ID, ISODate>();
  for (const p of input.payments) {
    if (p.status !== "pending_approval" && p.status !== "approved") continue;
    const prev = pendingByPayable.get(p.payableId);
    if (!prev || p.scheduledDate < prev) pendingByPayable.set(p.payableId, p.scheduledDate);
  }
  for (const p of [...input.payables].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p.status === "canceled") {
      excluded.push({ reason: "cancelado", origin: "contas_pagar", originId: p.id, amountCents: p.amountCents });
      continue;
    }
    const remaining = Math.max(0, p.amountCents - p.paidCents);
    if (remaining <= 0) continue;
    const cat = categoryOfPayable(p);
    push({
      cashDate: pendingByPayable.get(p.id) ?? p.dueDate,
      competenceDate: p.issueDate,
      kind: "saida",
      categoryId: cat.categoryId,
      mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys,
      description: p.description,
      costCenterId: p.costCenterId,
      status: "previsto",
      amountCents: remaining,
      origin: "contas_pagar",
      originId: p.id,
    });
  }
  for (const r of [...input.receivables].sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.status === "canceled") {
      excluded.push({ reason: "cancelado", origin: "contas_receber", originId: r.id, amountCents: r.amountCents });
      continue;
    }
    const remaining = Math.max(0, r.amountCents - r.receivedCents);
    if (remaining <= 0) continue;
    const cat = categoryOfReceivable(r);
    push({
      cashDate: r.dueDate,
      competenceDate: r.issueDate,
      kind: "entrada",
      categoryId: cat.categoryId,
      mappingSource: cat.mappingSource, mappingKeys: cat.mappingKeys,
      description: r.description,
      costCenterId: r.costCenterId,
      status: "previsto",
      amountCents: remaining,
      origin: "contas_receber",
      originId: r.id,
    });
  }

  // ---------------------------------------------------------------- 5. ajustes manuais
  for (const a of [...input.manualEntries].sort((x, y) => x.id.localeCompare(y.id))) {
    push({
      cashDate: a.competenceDate,
      competenceDate: a.competenceDate,
      kind: a.kind,
      categoryId: a.categoryId,
      mappingSource: "ajuste_manual",
      description: a.description,
      costCenterId: a.costCenterId,
      status: a.status,
      realizedBy: a.status === "realizado" ? "baixa_app" : undefined,
      amountCents: a.amountCents,
      origin: "ajuste_manual",
      originId: a.id,
    });
  }

  // Ordem total e determinística: mesma entrada → mesma saída, byte a byte.
  entries.sort(
    (a, b) =>
      a.cashDate.localeCompare(b.cashDate) ||
      a.origin.localeCompare(b.origin) ||
      a.originId.localeCompare(b.originId) ||
      a.amountCents - b.amountCents
  );
  excluded.sort((a, b) => a.origin.localeCompare(b.origin) || a.originId.localeCompare(b.originId) || a.reason.localeCompare(b.reason));
  return { entries, excluded };
}

/** Dias entre duas datas ISO (b − a), sem fuso. */
function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}

/** Recorte por ano base (regime de caixa: `year` vem da data de caixa). */
export function entriesOfYear(entries: CashflowEntry[], year: number): CashflowEntry[] {
  return entries.filter((e) => e.year === year);
}

/** Primeiro dia do mês seguinte à data (útil para janelas). */
export function nextMonthStart(date: ISODate): ISODate {
  const m = monthOf(date);
  const [y, mm] = m.split("-").map(Number);
  const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  return `${next}-01`;
}

// Reexportado para quem monta janelas a partir da unificação.
export { addDays };
