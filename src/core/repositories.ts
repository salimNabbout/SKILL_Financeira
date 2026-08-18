/**
 * Interfaces de repositório — contratos de persistência do domínio.
 * Implementações: adapters/memory (testes e modo demo) e adapters/prisma (produção).
 *
 * Convenção: além dos finders especializados (caminhos quentes), todo repositório
 * expõe listAll(companyId); em escala de MVP é aceitável filtrar em memória —
 * finders adicionais são otimização posterior sem quebra de contrato.
 */

import type { ISODate } from "./dates";
import type {
  AccountingEntry,
  Alert,
  Approval,
  ApprovalStatus,
  AuditRecord,
  BankAccount,
  BankTransaction,
  Budget,
  BudgetLine,
  Category,
  ChartAccount,
  CollectionMessage,
  CollectionMessageStatus,
  Company,
  CostCenter,
  Customer,
  EventRecordEntity,
  FinancialDocument,
  FlowRun,
  ID,
  IdempotencyRecord,
  Invoice,
  Membership,
  Payable,
  PayableStatus,
  Payment,
  PaymentStatus,
  Receipt,
  Receivable,
  ReceivableStatus,
  ReconciliationMatch,
  ReconciliationStatus,
  SkillExecution,
  Supplier,
  User,
} from "./entities";

/** CRUD básico para entidades com escopo de empresa. */
export interface BaseRepo<T extends { id: ID; companyId: ID }> {
  getById(companyId: ID, id: ID): Promise<T | null>;
  listAll(companyId: ID): Promise<T[]>;
  create(entity: T): Promise<T>;
  update(entity: T): Promise<T>;
}

// --- Entidades globais (sem escopo de empresa) ------------------------------

export interface CompanyRepo {
  getById(id: ID): Promise<Company | null>;
  findByCnpj(cnpj: string): Promise<Company | null>;
  listAll(): Promise<Company[]>;
  create(entity: Company): Promise<Company>;
  update(entity: Company): Promise<Company>;
}

export interface UserRepo {
  getById(id: ID): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  listAll(): Promise<User[]>;
  create(entity: User): Promise<User>;
  update(entity: User): Promise<User>;
}

export interface MembershipRepo {
  listByUser(userId: ID): Promise<Membership[]>;
  listByCompany(companyId: ID): Promise<Membership[]>;
  findByUserAndCompany(userId: ID, companyId: ID): Promise<Membership | null>;
  create(entity: Membership): Promise<Membership>;
  update(entity: Membership): Promise<Membership>;
}

// --- Cadastros --------------------------------------------------------------

export type CustomerRepo = BaseRepo<Customer>;
export type SupplierRepo = BaseRepo<Supplier>;
export type BankAccountRepo = BaseRepo<BankAccount>;
export type CategoryRepo = BaseRepo<Category>;
export type CostCenterRepo = BaseRepo<CostCenter>;
export type ChartAccountRepo = BaseRepo<ChartAccount>;

export interface FinancialDocumentRepo extends BaseRepo<FinancialDocument> {
  findByContentHash(companyId: ID, contentHash: string): Promise<FinancialDocument | null>;
}

export interface BankTransactionRepo extends BaseRepo<BankTransaction> {
  findByExternalId(
    companyId: ID,
    bankAccountId: ID,
    externalId: string
  ): Promise<BankTransaction | null>;
  listByAccount(companyId: ID, bankAccountId: ID): Promise<BankTransaction[]>;
  listUnreconciled(companyId: ID): Promise<BankTransaction[]>;
  listByDateRange(companyId: ID, start: ISODate, end: ISODate): Promise<BankTransaction[]>;
}

// --- Títulos e liquidações --------------------------------------------------

export interface PayableRepo extends BaseRepo<Payable> {
  findByOriginKey(companyId: ID, originKey: string): Promise<Payable | null>;
  listByStatus(companyId: ID, statuses: PayableStatus[]): Promise<Payable[]>;
  listDueBetween(companyId: ID, start: ISODate, end: ISODate): Promise<Payable[]>;
}

export interface ReceivableRepo extends BaseRepo<Receivable> {
  findByOriginKey(companyId: ID, originKey: string): Promise<Receivable | null>;
  listByStatus(companyId: ID, statuses: ReceivableStatus[]): Promise<Receivable[]>;
  listDueBetween(companyId: ID, start: ISODate, end: ISODate): Promise<Receivable[]>;
  listByCustomer(companyId: ID, customerId: ID): Promise<Receivable[]>;
}

export interface PaymentRepo extends BaseRepo<Payment> {
  listByStatus(companyId: ID, statuses: PaymentStatus[]): Promise<Payment[]>;
  listByPayable(companyId: ID, payableId: ID): Promise<Payment[]>;
}

export interface ReceiptRepo extends BaseRepo<Receipt> {
  listByReceivable(companyId: ID, receivableId: ID): Promise<Receipt[]>;
  listByDateRange(companyId: ID, start: ISODate, end: ISODate): Promise<Receipt[]>;
}

// --- Orçamento --------------------------------------------------------------

export type BudgetRepo = BaseRepo<Budget>;

export interface BudgetLineRepo {
  listByBudget(budgetId: ID): Promise<BudgetLine[]>;
  create(entity: BudgetLine): Promise<BudgetLine>;
  update(entity: BudgetLine): Promise<BudgetLine>;
}

// --- Governança -------------------------------------------------------------

export interface ApprovalRepo extends BaseRepo<Approval> {
  listByStatus(companyId: ID, statuses: ApprovalStatus[]): Promise<Approval[]>;
}

export interface ReconciliationRepo extends BaseRepo<ReconciliationMatch> {
  listByStatus(companyId: ID, statuses: ReconciliationStatus[]): Promise<ReconciliationMatch[]>;
  listByBankTransaction(companyId: ID, bankTransactionId: ID): Promise<ReconciliationMatch[]>;
}

export interface AlertRepo extends BaseRepo<Alert> {
  listOpen(companyId: ID): Promise<Alert[]>;
}

export interface EventRepo {
  append(event: EventRecordEntity): Promise<void>;
  list(companyId: ID, type?: string): Promise<EventRecordEntity[]>;
}

export interface SkillExecutionRepo {
  create(entity: SkillExecution): Promise<SkillExecution>;
  list(companyId: ID, skill?: string): Promise<SkillExecution[]>;
}

/** Trilha de auditoria: append-only. Não há update nem delete. */
export interface AuditRepo {
  append(record: AuditRecord): Promise<void>;
  last(companyId: ID): Promise<AuditRecord | null>;
  list(companyId: ID, filter?: { entityType?: string; entityId?: ID }): Promise<AuditRecord[]>;
}

// --- Faturamento, cobrança, contabilidade -----------------------------------

export type InvoiceRepo = BaseRepo<Invoice>;

export interface CollectionMessageRepo extends BaseRepo<CollectionMessage> {
  listByStatus(companyId: ID, statuses: CollectionMessageStatus[]): Promise<CollectionMessage[]>;
}

export interface AccountingEntryRepo extends BaseRepo<AccountingEntry> {
  listUnexported(companyId: ID): Promise<AccountingEntry[]>;
  listByDateRange(companyId: ID, start: ISODate, end: ISODate): Promise<AccountingEntry[]>;
}

// --- Orquestrador -----------------------------------------------------------

export interface FlowRunRepo extends BaseRepo<FlowRun> {
  findByApprovalId(companyId: ID, approvalId: ID): Promise<FlowRun | null>;
}

export interface IdempotencyRepo {
  findByKey(companyId: ID, key: string): Promise<IdempotencyRecord | null>;
  save(record: IdempotencyRecord): Promise<void>;
}

// --- Bundle -----------------------------------------------------------------

export interface Repositories {
  companies: CompanyRepo;
  users: UserRepo;
  memberships: MembershipRepo;
  customers: CustomerRepo;
  suppliers: SupplierRepo;
  bankAccounts: BankAccountRepo;
  bankTransactions: BankTransactionRepo;
  payables: PayableRepo;
  receivables: ReceivableRepo;
  payments: PaymentRepo;
  receipts: ReceiptRepo;
  documents: FinancialDocumentRepo;
  categories: CategoryRepo;
  costCenters: CostCenterRepo;
  chartAccounts: ChartAccountRepo;
  budgets: BudgetRepo;
  budgetLines: BudgetLineRepo;
  approvals: ApprovalRepo;
  reconciliations: ReconciliationRepo;
  alerts: AlertRepo;
  events: EventRepo;
  skillExecutions: SkillExecutionRepo;
  audit: AuditRepo;
  invoices: InvoiceRepo;
  collectionMessages: CollectionMessageRepo;
  accountingEntries: AccountingEntryRepo;
  flowRuns: FlowRunRepo;
  idempotency: IdempotencyRepo;
}
