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
  RecurringTemplate,
  PaymentStatus,
  Receipt,
  Receivable,
  ReceivableStatus,
  ReconciliationMatch,
  ReconciliationStatus,
  SkillExecution,
  Supplier,
  SupplierCategory,
  User,
} from "./entities";

/** CRUD básico para entidades com escopo de empresa. */
export interface BaseRepo<T extends { id: ID; companyId: ID }> {
  getById(companyId: ID, id: ID): Promise<T | null>;
  listAll(companyId: ID): Promise<T[]>;
  create(entity: T): Promise<T>;
  update(entity: T): Promise<T>;
}

// --- Paginação (volumetria) -------------------------------------------------
// Superfícies de LISTAGEM (telas e API) usam finders paginados com ordem
// determinística; skills que agregam continuam com listAll (cálculo, não
// listagem) — decisão documentada em docs/12.

export interface PageQuery {
  offset?: number; // default 0
  limit?: number; // default 50 (máx. aplicado na borda da API)
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
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
export interface SupplierRepo extends BaseRepo<Supplier> {
  /** Remove um fornecedor. O chamador garante que não há vínculos (títulos). */
  delete(companyId: ID, id: ID): Promise<void>;
}
export type SupplierCategoryRepo = BaseRepo<SupplierCategory>;

export interface RecurringTemplateRepo extends BaseRepo<RecurringTemplate> {
  /** Recorrências com status "active" (candidatas à geração). */
  listActive(companyId: ID): Promise<RecurringTemplate[]>;
}

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
  /** Ordem: data desc, id desc. */
  listPage(
    companyId: ID,
    query: PageQuery & { bankAccountId?: ID; reconciled?: boolean }
  ): Promise<Page<BankTransaction>>;
}

// --- Títulos e liquidações --------------------------------------------------

export interface PayableRepo extends BaseRepo<Payable> {
  findByOriginKey(companyId: ID, originKey: string): Promise<Payable | null>;
  listByStatus(companyId: ID, statuses: PayableStatus[]): Promise<Payable[]>;
  listDueBetween(companyId: ID, start: ISODate, end: ISODate): Promise<Payable[]>;
  /**
   * Ordem: vencimento asc, id asc. Filtros de status, fornecedor e intervalo
   * de vencimento (dueFrom/dueTo, inclusivos) são aplicados no banco — a
   * paginação e o `total` refletem o filtro.
   */
  listPage(
    companyId: ID,
    query: PageQuery & {
      statuses?: PayableStatus[];
      supplierId?: ID;
      dueFrom?: ISODate;
      dueTo?: ISODate;
    }
  ): Promise<Page<Payable>>;
}

export interface ReceivableRepo extends BaseRepo<Receivable> {
  findByOriginKey(companyId: ID, originKey: string): Promise<Receivable | null>;
  listByStatus(companyId: ID, statuses: ReceivableStatus[]): Promise<Receivable[]>;
  listDueBetween(companyId: ID, start: ISODate, end: ISODate): Promise<Receivable[]>;
  listByCustomer(companyId: ID, customerId: ID): Promise<Receivable[]>;
  /**
   * Ordem: vencimento asc, id asc. Filtros de status, cliente e intervalo de
   * vencimento (dueFrom/dueTo, inclusivos) são aplicados no banco — a paginação
   * e o `total` refletem o filtro.
   */
  listPage(
    companyId: ID,
    query: PageQuery & {
      statuses?: ReceivableStatus[];
      customerId?: ID;
      dueFrom?: ISODate;
      dueTo?: ISODate;
    }
  ): Promise<Page<Receivable>>;
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
  /**
   * Atualização condicional (compare-and-set) por status atual: grava `next`
   * apenas se o status persistido ainda for `expectedStatus`. Devolve true se
   * gravou, false se outra decisão concorrente já mudou o status. É a trava que
   * impede duas decisões simultâneas de executarem o passo sensível duas vezes.
   */
  updateIfStatus(
    next: Approval,
    expectedStatus: ApprovalStatus
  ): Promise<boolean>;
  /**
   * Compare-and-set por VERSÃO: grava `next` (com version incrementada) apenas
   * se a versão persistida for `expectedVersion`. Devolve true se gravou. Usado
   * nas aprovações parciais (four-eyes) para não perder votos concorrentes: a
   * decisão perdedora relê e reaplica sobre a versão nova.
   */
  updateIfVersion(next: Approval, expectedVersion: number): Promise<boolean>;
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
  /** Ordem: occurredAt desc, id desc. */
  listPage(
    companyId: ID,
    query: PageQuery & { type?: string }
  ): Promise<Page<EventRecordEntity>>;
}

export interface SkillExecutionRepo {
  create(entity: SkillExecution): Promise<SkillExecution>;
  list(companyId: ID, skill?: string): Promise<SkillExecution[]>;
}

/** Âncora do último registro da cadeia de auditoria de uma empresa. */
export interface AuditHead {
  companyId: ID;
  seq: number;
  hash: string;
}

/** Trilha de auditoria: append-only. Não há update nem delete. */
export interface AuditRepo {
  append(record: AuditRecord): Promise<void>;
  last(companyId: ID): Promise<AuditRecord | null>;
  list(companyId: ID, filter?: { entityType?: string; entityId?: ID }): Promise<AuditRecord[]>;
  /** Ordem: seq desc. */
  listPage(
    companyId: ID,
    query: PageQuery & { entityType?: string; entityId?: ID }
  ): Promise<Page<AuditRecord>>;
  /**
   * Âncora do head (seq/hash do último registro) guardada à parte da lista de
   * registros — permite detectar truncamento do FIM da trilha (registros
   * apagados no fim mantêm um prefixo válido, mas divergem do head ancorado).
   */
  getHead(companyId: ID): Promise<AuditHead | null>;
  setHead(head: AuditHead): Promise<void>;
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
  /**
   * Reserva ATÔMICA da chave (INSERT que respeita o unique (companyId, key)):
   * cria o registro se ausente e devolve { reserved: true }; se já existir,
   * devolve { reserved: false, existing }. É o ponto de serialização que impede
   * duas execuções concorrentes da mesma chave de rodarem ambas.
   */
  reserve(record: IdempotencyRecord): Promise<{ reserved: boolean; existing?: IdempotencyRecord }>;
  /** Remove a reserva (usado para liberar a chave quando a execução falha antes de concluir). */
  remove(companyId: ID, key: string): Promise<void>;
}

// --- Bundle -----------------------------------------------------------------

export interface Repositories {
  companies: CompanyRepo;
  users: UserRepo;
  memberships: MembershipRepo;
  customers: CustomerRepo;
  suppliers: SupplierRepo;
  supplierCategories: SupplierCategoryRepo;
  recurringTemplates: RecurringTemplateRepo;
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
  /**
   * Executa `fn` numa transação: as escritas feitas pelos repositórios passados
   * a `fn` commitam juntas, ou são revertidas por completo se `fn` lançar.
   * Prisma: transação real do banco. Memória: snapshot/restaura em caso de erro.
   * Usado onde negócio + auditoria + evento precisam ser atômicos.
   */
  withTransaction<T>(fn: (txRepos: Repositories) => Promise<T>): Promise<T>;
}
