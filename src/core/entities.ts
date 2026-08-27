/**
 * Entidades de domínio. Espelham o schema Prisma, mas no domínio:
 * - valores monetários: number de centavos (seguro até ~90 trilhões de centavos);
 * - datas de negócio: ISODate "YYYY-MM-DD"; carimbos: string ISO-8601 UTC.
 * A conversão BigInt<->number acontece só na borda do adaptador Prisma.
 */

import type { ISODate } from "./dates";
import type { CurrencyCode } from "./money";
import type { AlertSeverity, SkillStatus } from "./types";

export type ID = string;

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export type RoleName =
  | "admin"
  | "finance_manager"
  | "approver"
  | "finance_analyst"
  | "accountant"
  | "viewer";

export interface Company {
  id: ID;
  name: string;
  legalName?: string;
  cnpj: string;
  timezone: string; // ex.: America/Sao_Paulo
  defaultCurrency: CurrencyCode;
  /** Políticas da empresa (alçadas, juros, régua, regras tributárias) — ver CompanyConfig. */
  config?: unknown;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: ID;
  name: string;
  email: string;
  passwordHash: string;
  /** Segredo TOTP (base32) — NUNCA expor em respostas/auditoria. */
  totpSecret?: string;
  /** 2FA ativo: login passa a exigir código TOTP válido. Ausente = falso. */
  totpEnabled?: boolean;
  /** Último counter TOTP consumido — bloqueia reuso do mesmo código (anti-replay). */
  totpLastCounter?: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  id: ID;
  userId: ID;
  companyId: ID;
  role: RoleName;
  /** Limite de alçada em centavos; null = ilimitado dentro do papel. */
  approvalLimitCents: number | null;
}

/** Quem está executando uma ação (humano, sistema ou skill). */
export interface Actor {
  type: "user" | "system" | "skill";
  id: ID; // userId, "system" ou nome da skill
  role?: RoleName;
}

// ---------------------------------------------------------------------------
// Cadastros
// ---------------------------------------------------------------------------

export interface Customer {
  id: ID;
  companyId: ID;
  name: string;
  document?: string;
  email?: string;
  phone?: string;
  address?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Classificação de custo do fornecedor (fixo vs. variável) — para relatórios futuros. */
export type CostClassification = "fixed" | "variable";

export interface Supplier {
  id: ID;
  companyId: ID;
  name: string;
  document?: string;
  email?: string;
  phone?: string;
  address?: string;
  /** Classificação do custo associada ao fornecedor. */
  costClassification?: CostClassification;
  /** Categoria livre do fornecedor (guardada em Title Case). */
  category?: string;
  /** Dados bancários SEMPRE mascarados no domínio e nos logs. */
  bankInfoMasked?: string;
  pixKeyMasked?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Categoria de fornecedores cadastrável (lista que alimenta o campo CATEGORIA). */
export interface SupplierCategory {
  id: ID;
  companyId: ID;
  /** Nome guardado em Title Case; único por empresa. */
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Tipo de recorrência: título a pagar ou a receber. */
export type RecurringKind = "payable" | "receivable";
/** Estado da recorrência. `paused` suspende a geração; `ended` a encerra. */
export type RecurringStatus = "active" | "paused" | "ended";

/**
 * Modelo de recorrência mensal. Cadastrado uma vez; o scheduler gera o título
 * do mês (a pagar ou a receber) automaticamente, com vencimento no `dueDay`.
 */
export interface RecurringTemplate {
  id: ID;
  companyId: ID;
  kind: RecurringKind;
  /** Fornecedor (kind=payable) ou cliente (kind=receivable). */
  counterpartyId: ID;
  description: string;
  amountCents: number;
  /** Dia do vencimento (1–31); dias inexistentes caem no último dia do mês. */
  dueDay: number;
  /** Categoria de fornecedor (texto), só para kind=payable. */
  category?: string;
  /** Classificação de custo, só para kind=payable. */
  costClassification?: CostClassification;
  /** A partir de quando gerar (inclusive). */
  startDate: ISODate;
  /** Até quando gerar (inclusive); ausente = indefinido. */
  endDate?: ISODate;
  status: RecurringStatus;
  createdBy: ID;
  createdAt: string;
  updatedAt: string;
}

export type BankAccountType = "checking" | "savings" | "payment";

export interface BankAccount {
  id: ID;
  companyId: ID;
  name: string;
  bankCode: string;
  agency: string;
  accountNumberMasked: string;
  type: BankAccountType;
  currency: CurrencyCode;
  openingBalanceCents: number;
  openingBalanceDate: ISODate;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BankTransactionSource = "ofx" | "csv" | "cnab240" | "api_mock" | "manual";

export interface BankTransaction {
  id: ID;
  companyId: ID;
  bankAccountId: ID;
  date: ISODate;
  /** Com sinal: crédito > 0, débito < 0. */
  amountCents: number;
  currency: CurrencyCode;
  description: string;
  /** FITID do OFX ou hash determinístico (deduplicação de importação). */
  externalId?: string;
  importBatchId?: string;
  source: BankTransactionSource;
  reconciled: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Contas a pagar / receber
// ---------------------------------------------------------------------------

export type PayableStatus = "open" | "scheduled" | "partially_paid" | "paid" | "canceled";

export interface Payable {
  id: ID;
  companyId: ID;
  supplierId: ID;
  documentId?: ID;
  description: string;
  issueDate: ISODate;
  dueDate: ISODate;
  amountCents: number;
  paidCents: number;
  currency: CurrencyCode;
  status: PayableStatus;
  categoryId?: ID;
  costCenterId?: ID;
  /** Categoria de fornecedor (texto), espelhada do cadastro no momento da entrada. */
  supplierCategory?: string;
  /** Classificação de custo (Fixo/Variável), espelhada do fornecedor na entrada. */
  costClassification?: CostClassification;
  installmentNumber: number;
  installmentCount: number;
  /** Idempotência: fornecedor+documento+parcela. Único por empresa. */
  originKey: string;
  notes?: string;
  canceledAt?: string;
  createdBy: ID;
  createdAt: string;
  updatedAt: string;
}

export type ReceivableStatus = "open" | "partially_received" | "received" | "canceled";
export type ReceiptMethod = "pix" | "boleto" | "card" | "transfer" | "cash";

export interface Receivable {
  id: ID;
  companyId: ID;
  customerId: ID;
  invoiceId?: ID;
  documentId?: ID;
  description: string;
  issueDate: ISODate;
  dueDate: ISODate;
  amountCents: number;
  receivedCents: number;
  currency: CurrencyCode;
  status: ReceivableStatus;
  method?: ReceiptMethod;
  categoryId?: ID;
  costCenterId?: ID;
  installmentNumber: number;
  installmentCount: number;
  originKey: string;
  notes?: string;
  canceledAt?: string;
  createdBy: ID;
  createdAt: string;
  updatedAt: string;
}

export type PaymentStatus = "pending_approval" | "approved" | "executed" | "rejected" | "canceled";

/** Pagamento de título — NUNCA executado sem aprovação humana registrada. */
export interface Payment {
  id: ID;
  companyId: ID;
  payableId: ID;
  bankAccountId: ID;
  amountCents: number;
  scheduledDate: ISODate;
  executedAt?: string;
  status: PaymentStatus;
  approvalId?: ID;
  requestedBy: ID;
  executedBy?: ID;
  createdAt: string;
  updatedAt: string;
}

export interface Receipt {
  id: ID;
  companyId: ID;
  receivableId: ID;
  bankAccountId?: ID;
  amountCents: number;
  receivedDate: ISODate;
  method: ReceiptMethod;
  /** userId ou "system" (baixa automática via conciliação). */
  registeredBy: ID;
  createdAt: string;
}

export type FinancialDocumentType = "nfe" | "nfse" | "invoice" | "receipt" | "contract" | "other";

export interface FinancialDocument {
  id: ID;
  companyId: ID;
  type: FinancialDocumentType;
  number: string;
  series?: string;
  issuerName: string;
  issuerDoc?: string;
  issuedAt: ISODate;
  totalCents: number;
  contentHash: string;
  raw?: unknown;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

export type CategoryKind = "income" | "expense";

export type DreGroup =
  | "receita_bruta"
  | "deducoes"
  | "custos"
  | "despesas_operacionais"
  | "despesas_financeiras"
  | "receitas_financeiras"
  | "outras";

export interface Category {
  id: ID;
  companyId: ID;
  name: string;
  kind: CategoryKind;
  dreGroup: DreGroup;
  parentId?: ID;
  active: boolean;
}

/** Onde o centro de custo pode ser usado ao lançar. */
export type CostCenterScope = "payable" | "receivable" | "both";

export interface CostCenter {
  id: ID;
  companyId: ID;
  code: string;
  name: string;
  active: boolean;
  /** Filtra apenas lançamentos NOVOS; títulos já vinculados não são afetados. */
  scope: CostCenterScope;
}

export type ChartAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface ChartAccount {
  id: ID;
  companyId: ID;
  code: string;
  name: string;
  type: ChartAccountType;
  parentCode?: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Orçamento
// ---------------------------------------------------------------------------

export interface Budget {
  id: ID;
  companyId: ID;
  name: string;
  year: number;
  status: "draft" | "active" | "archived";
  createdAt: string;
}

export interface BudgetLine {
  id: ID;
  budgetId: ID;
  period: string; // YYYY-MM
  categoryId?: ID;
  costCenterId?: ID;
  amountCents: number;
}

// ---------------------------------------------------------------------------
// Governança
// ---------------------------------------------------------------------------

export type ApprovalTargetType =
  | "payment"
  | "collection_message"
  | "bank_change"
  | "deletion"
  | "flow_step";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: ID;
  companyId: ID;
  targetType: ApprovalTargetType;
  targetId: ID;
  flowRunId?: ID;
  summary: string;
  amountCents?: number;
  requestedBy: ID;
  requiredRole: RoleName;
  /** Dupla aprovação (four-eyes): total de aprovações exigidas. Ausente = 1. */
  approvalsRequired?: number;
  /** Usuários que JÁ aprovaram (aprovação parcial); decisão final ao atingir o total. */
  approverIds?: ID[];
  status: ApprovalStatus;
  decidedBy?: ID;
  decidedAt?: string;
  justification?: string;
  /** Versão para trava otimista (four-eyes sem lost-update). Ausente = 0. */
  version?: number;
  createdAt: string;
}

export type ReconciliationTargetType =
  | "payment"
  | "receipt"
  | "payable"
  | "receivable"
  | "transfer"
  | "unknown";

export type ReconciliationStatus = "auto_confirmed" | "suggested" | "confirmed" | "rejected";

export interface ReconciliationMatch {
  id: ID;
  companyId: ID;
  bankTransactionId: ID;
  targetType: ReconciliationTargetType;
  /** Título/liquidação alvo; para "transfer", a transação bancária contraparte. */
  targetId?: ID;
  /**
   * Porção (valor absoluto, centavos) da transação aplicada a este alvo.
   * Ausente = comportamento integral (valor da transação). Permite baixas
   * parciais e o rateio de uma transação entre várias parcelas.
   */
  amountCents?: number;
  /** Matches decididos em conjunto (rateio multi-parcela ou par de transferência). */
  groupId?: ID;
  confidence: number;
  status: ReconciliationStatus;
  matchedBy: string; // "system" | userId
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecordEntity {
  id: ID;
  companyId: ID;
  type: string;
  payload: unknown;
  source: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
}

export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: ID;
  companyId: ID;
  severity: AlertSeverity;
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
  source: string;
  status: AlertStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface SkillExecution {
  id: ID;
  companyId: ID;
  flowRunId?: ID;
  skill: string;
  action: string;
  inputHash: string;
  status: SkillStatus;
  confidence: number;
  result: unknown;
  startedAt: string;
  finishedAt: string;
}

/** Registro de auditoria imutável — encadeado por hash (hash = sha256(prevHash + conteúdo)). */
export interface AuditRecord {
  id: ID;
  companyId: ID;
  seq: number;
  actorType: "user" | "system" | "skill";
  actorId: ID;
  action: string;
  entityType: string;
  entityId: ID;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
  timestamp: string;
  prevHash: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Faturamento, cobrança, contabilidade
// ---------------------------------------------------------------------------

export type InvoiceStatus = "draft" | "issued" | "canceled";

export interface Invoice {
  id: ID;
  companyId: ID;
  customerId: ID;
  saleRef?: string;
  description: string;
  totalCents: number;
  issueDate?: ISODate;
  status: InvoiceStatus;
  /** Dados fiscais emitidos via porta FiscalProvider (provider "mock" no MVP). */
  nfeMock?: { number: string; accessKey: string; issuedAt: string; provider: string };
  createdBy: ID;
  createdAt: string;
  updatedAt: string;
}

export type CollectionChannel = "email" | "whatsapp_mock" | "letter";
export type CollectionMessageStatus = "draft" | "awaiting_approval" | "approved" | "sent" | "canceled";

export interface CollectionMessage {
  id: ID;
  companyId: ID;
  receivableId: ID;
  customerId: ID;
  step: number;
  channel: CollectionChannel;
  subject: string;
  body: string;
  status: CollectionMessageStatus;
  approvalId?: ID;
  sentAt?: string; // envio real é MOCK no MVP
  createdAt: string;
  updatedAt: string;
}

export type AccountingSourceType = "payment" | "receipt" | "payable" | "receivable" | "adjustment";

export interface AccountingEntry {
  id: ID;
  companyId: ID;
  entryDate: ISODate;
  debitAccount: string;
  creditAccount: string;
  amountCents: number;
  memo: string;
  sourceType: AccountingSourceType;
  sourceId: ID;
  exportBatchId?: string;
  exported: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------

export type FlowRunStatus = "running" | "awaiting_approval" | "completed" | "failed" | "rejected";

export interface FlowRun {
  id: ID;
  companyId: ID;
  flow: string;
  status: FlowRunStatus;
  cursor: number;
  payload: unknown;
  results: unknown[]; // SkillResult[] serializados
  approvalId?: ID;
  idempotencyKey: string;
  correlationId: string;
  requestedBy: ID;
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyRecord {
  id: ID;
  companyId: ID;
  key: string;
  requestHash: string;
  result: unknown;
  createdAt: string;
}
