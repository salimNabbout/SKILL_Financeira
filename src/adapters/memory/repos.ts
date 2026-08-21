/** Implementação em memória de todos os repositórios do domínio. */

import type { ISODate } from "@/core/dates";
import type {
  AccountingEntry,
  Alert,
  ApprovalStatus,
  AuditRecord,
  BankTransaction,
  BudgetLine,
  CollectionMessage,
  CollectionMessageStatus,
  Company,
  EventRecordEntity,
  FinancialDocument,
  FlowRun,
  ID,
  IdempotencyRecord,
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
} from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import type {
  AccountingEntryRepo,
  AlertRepo,
  ApprovalRepo,
  AuditHead,
  AuditRepo,
  BankTransactionRepo,
  BaseRepo,
  BudgetLineRepo,
  CollectionMessageRepo,
  CompanyRepo,
  EventRepo,
  FinancialDocumentRepo,
  FlowRunRepo,
  IdempotencyRepo,
  MembershipRepo,
  PayableRepo,
  PaymentRepo,
  ReceiptRepo,
  ReceivableRepo,
  ReconciliationRepo,
  Repositories,
  SkillExecutionRepo,
  SupplierRepo,
  UserRepo,
} from "@/core/repositories";
import type { MemoryDb } from "./db";

const clone = <T>(value: T): T => structuredClone(value);

/** Paginação em memória com ordem determinística já aplicada pelo chamador. */
function paginate<T>(
  sorted: T[],
  query: { offset?: number; limit?: number }
): { items: T[]; total: number; offset: number; limit: number } {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, query.limit ?? 50);
  return {
    items: clone(sorted.slice(offset, offset + limit)),
    total: sorted.length,
    offset,
    limit,
  };
}

class MemBase<T extends { id: ID; companyId: ID }> implements BaseRepo<T> {
  constructor(protected readonly items: T[]) {}

  async getById(companyId: ID, id: ID): Promise<T | null> {
    const found = this.items.find((i) => i.companyId === companyId && i.id === id);
    return found ? clone(found) : null;
  }

  async listAll(companyId: ID): Promise<T[]> {
    return clone(this.items.filter((i) => i.companyId === companyId));
  }

  async create(entity: T): Promise<T> {
    if (this.items.some((i) => i.id === entity.id)) {
      throw new ValidationError(`Registro duplicado (id ${entity.id}).`);
    }
    this.items.push(clone(entity));
    return clone(entity);
  }

  async update(entity: T): Promise<T> {
    const idx = this.items.findIndex(
      (i) => i.companyId === entity.companyId && i.id === entity.id
    );
    if (idx < 0) throw new NotFoundError("Registro", entity.id);
    this.items[idx] = clone(entity);
    return clone(entity);
  }
}

class MemSupplierRepo extends MemBase<Supplier> implements SupplierRepo {
  async delete(companyId: ID, id: ID): Promise<void> {
    const idx = this.items.findIndex((s) => s.companyId === companyId && s.id === id);
    if (idx >= 0) this.items.splice(idx, 1);
  }
}

class MemCompanyRepo implements CompanyRepo {
  constructor(private readonly items: Company[]) {}
  async getById(id: ID) {
    return clone(this.items.find((c) => c.id === id) ?? null);
  }
  async findByCnpj(cnpj: string) {
    return clone(this.items.find((c) => c.cnpj === cnpj) ?? null);
  }
  async listAll() {
    return clone(this.items);
  }
  async create(entity: Company) {
    if (this.items.some((c) => c.id === entity.id || c.cnpj === entity.cnpj)) {
      throw new ValidationError(`Empresa duplicada (${entity.cnpj}).`);
    }
    this.items.push(clone(entity));
    return clone(entity);
  }
  async update(entity: Company) {
    const idx = this.items.findIndex((c) => c.id === entity.id);
    if (idx < 0) throw new NotFoundError("Empresa", entity.id);
    this.items[idx] = clone(entity);
    return clone(entity);
  }
}

class MemUserRepo implements UserRepo {
  constructor(private readonly items: User[]) {}
  async getById(id: ID) {
    return clone(this.items.find((u) => u.id === id) ?? null);
  }
  async findByEmail(email: string) {
    return clone(this.items.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null);
  }
  async listAll() {
    return clone(this.items);
  }
  async create(entity: User) {
    if (this.items.some((u) => u.id === entity.id || u.email === entity.email)) {
      throw new ValidationError(`Usuário duplicado (${entity.email}).`);
    }
    this.items.push(clone(entity));
    return clone(entity);
  }
  async update(entity: User) {
    const idx = this.items.findIndex((u) => u.id === entity.id);
    if (idx < 0) throw new NotFoundError("Usuário", entity.id);
    this.items[idx] = clone(entity);
    return clone(entity);
  }
}

class MemMembershipRepo implements MembershipRepo {
  constructor(private readonly items: Membership[]) {}
  async listByUser(userId: ID) {
    return clone(this.items.filter((m) => m.userId === userId));
  }
  async listByCompany(companyId: ID) {
    return clone(this.items.filter((m) => m.companyId === companyId));
  }
  async findByUserAndCompany(userId: ID, companyId: ID) {
    return clone(
      this.items.find((m) => m.userId === userId && m.companyId === companyId) ?? null
    );
  }
  async create(entity: Membership) {
    if (this.items.some((m) => m.userId === entity.userId && m.companyId === entity.companyId)) {
      throw new ValidationError("Vínculo usuário-empresa já existe.");
    }
    this.items.push(clone(entity));
    return clone(entity);
  }
  async update(entity: Membership) {
    const idx = this.items.findIndex((m) => m.id === entity.id);
    if (idx < 0) throw new NotFoundError("Vínculo", entity.id);
    this.items[idx] = clone(entity);
    return clone(entity);
  }
}

class MemDocumentRepo extends MemBase<FinancialDocument> implements FinancialDocumentRepo {
  async findByContentHash(companyId: ID, contentHash: string) {
    const found = this.items.find(
      (d) => d.companyId === companyId && d.contentHash === contentHash
    );
    return found ? clone(found) : null;
  }
}

class MemBankTransactionRepo extends MemBase<BankTransaction> implements BankTransactionRepo {
  async findByExternalId(companyId: ID, bankAccountId: ID, externalId: string) {
    const found = this.items.find(
      (t) =>
        t.companyId === companyId &&
        t.bankAccountId === bankAccountId &&
        t.externalId === externalId
    );
    return found ? clone(found) : null;
  }
  async listByAccount(companyId: ID, bankAccountId: ID) {
    return clone(
      this.items.filter((t) => t.companyId === companyId && t.bankAccountId === bankAccountId)
    );
  }
  async listUnreconciled(companyId: ID) {
    return clone(this.items.filter((t) => t.companyId === companyId && !t.reconciled));
  }
  async listByDateRange(companyId: ID, start: ISODate, end: ISODate) {
    return clone(
      this.items.filter((t) => t.companyId === companyId && t.date >= start && t.date <= end)
    );
  }
  async listPage(
    companyId: ID,
    query: { offset?: number; limit?: number; bankAccountId?: ID; reconciled?: boolean }
  ) {
    const filtered = this.items
      .filter(
        (t) =>
          t.companyId === companyId &&
          (query.bankAccountId === undefined || t.bankAccountId === query.bankAccountId) &&
          (query.reconciled === undefined || t.reconciled === query.reconciled)
      )
      .sort((a, b) => (a.date !== b.date ? (a.date > b.date ? -1 : 1) : a.id > b.id ? -1 : 1));
    return paginate(filtered, query);
  }
}

class MemPayableRepo extends MemBase<Payable> implements PayableRepo {
  async findByOriginKey(companyId: ID, originKey: string) {
    const found = this.items.find(
      (p) => p.companyId === companyId && p.originKey === originKey
    );
    return found ? clone(found) : null;
  }
  async listByStatus(companyId: ID, statuses: PayableStatus[]) {
    return clone(
      this.items.filter((p) => p.companyId === companyId && statuses.includes(p.status))
    );
  }
  async listDueBetween(companyId: ID, start: ISODate, end: ISODate) {
    return clone(
      this.items.filter(
        (p) => p.companyId === companyId && p.dueDate >= start && p.dueDate <= end
      )
    );
  }
  async listPage(
    companyId: ID,
    query: { offset?: number; limit?: number; statuses?: PayableStatus[] }
  ) {
    const filtered = this.items
      .filter(
        (p) =>
          p.companyId === companyId &&
          (query.statuses === undefined || query.statuses.includes(p.status))
      )
      .sort((a, b) =>
        a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1
      );
    return paginate(filtered, query);
  }
}

class MemReceivableRepo extends MemBase<Receivable> implements ReceivableRepo {
  async findByOriginKey(companyId: ID, originKey: string) {
    const found = this.items.find(
      (r) => r.companyId === companyId && r.originKey === originKey
    );
    return found ? clone(found) : null;
  }
  async listByStatus(companyId: ID, statuses: ReceivableStatus[]) {
    return clone(
      this.items.filter((r) => r.companyId === companyId && statuses.includes(r.status))
    );
  }
  async listDueBetween(companyId: ID, start: ISODate, end: ISODate) {
    return clone(
      this.items.filter(
        (r) => r.companyId === companyId && r.dueDate >= start && r.dueDate <= end
      )
    );
  }
  async listByCustomer(companyId: ID, customerId: ID) {
    return clone(
      this.items.filter((r) => r.companyId === companyId && r.customerId === customerId)
    );
  }
  async listPage(
    companyId: ID,
    query: { offset?: number; limit?: number; statuses?: ReceivableStatus[] }
  ) {
    const filtered = this.items
      .filter(
        (r) =>
          r.companyId === companyId &&
          (query.statuses === undefined || query.statuses.includes(r.status))
      )
      .sort((a, b) =>
        a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1
      );
    return paginate(filtered, query);
  }
}

class MemPaymentRepo extends MemBase<Payment> implements PaymentRepo {
  async listByStatus(companyId: ID, statuses: PaymentStatus[]) {
    return clone(
      this.items.filter((p) => p.companyId === companyId && statuses.includes(p.status))
    );
  }
  async listByPayable(companyId: ID, payableId: ID) {
    return clone(
      this.items.filter((p) => p.companyId === companyId && p.payableId === payableId)
    );
  }
}

class MemReceiptRepo extends MemBase<Receipt> implements ReceiptRepo {
  async listByReceivable(companyId: ID, receivableId: ID) {
    return clone(
      this.items.filter((r) => r.companyId === companyId && r.receivableId === receivableId)
    );
  }
  async listByDateRange(companyId: ID, start: ISODate, end: ISODate) {
    return clone(
      this.items.filter(
        (r) => r.companyId === companyId && r.receivedDate >= start && r.receivedDate <= end
      )
    );
  }
}

class MemBudgetLineRepo implements BudgetLineRepo {
  constructor(private readonly items: BudgetLine[]) {}
  async listByBudget(budgetId: ID) {
    return clone(this.items.filter((l) => l.budgetId === budgetId));
  }
  async create(entity: BudgetLine) {
    if (this.items.some((l) => l.id === entity.id)) {
      throw new ValidationError(`Linha de orçamento duplicada (${entity.id}).`);
    }
    this.items.push(clone(entity));
    return clone(entity);
  }
  async update(entity: BudgetLine) {
    const idx = this.items.findIndex((l) => l.id === entity.id);
    if (idx < 0) throw new NotFoundError("Linha de orçamento", entity.id);
    this.items[idx] = clone(entity);
    return clone(entity);
  }
}

class MemApprovalRepo extends MemBase<import("@/core/entities").Approval> implements ApprovalRepo {
  async listByStatus(companyId: ID, statuses: ApprovalStatus[]) {
    return clone(
      this.items.filter((a) => a.companyId === companyId && statuses.includes(a.status))
    );
  }
  async updateIfStatus(next: import("@/core/entities").Approval, expectedStatus: ApprovalStatus) {
    const idx = this.items.findIndex(
      (a) => a.companyId === next.companyId && a.id === next.id
    );
    if (idx < 0) return false;
    // Compare-and-set atômico (single-thread): só grava se o status persistido
    // ainda for o esperado — a decisão concorrente perdedora recebe false.
    if (this.items[idx].status !== expectedStatus) return false;
    this.items[idx] = clone(next);
    return true;
  }
  async updateIfVersion(next: import("@/core/entities").Approval, expectedVersion: number) {
    const idx = this.items.findIndex(
      (a) => a.companyId === next.companyId && a.id === next.id
    );
    if (idx < 0) return false;
    if ((this.items[idx].version ?? 0) !== expectedVersion) return false;
    this.items[idx] = clone(next);
    return true;
  }
}

class MemReconciliationRepo extends MemBase<ReconciliationMatch> implements ReconciliationRepo {
  async listByStatus(companyId: ID, statuses: ReconciliationStatus[]) {
    return clone(
      this.items.filter((m) => m.companyId === companyId && statuses.includes(m.status))
    );
  }
  async listByBankTransaction(companyId: ID, bankTransactionId: ID) {
    return clone(
      this.items.filter(
        (m) => m.companyId === companyId && m.bankTransactionId === bankTransactionId
      )
    );
  }
}

class MemAlertRepo extends MemBase<Alert> implements AlertRepo {
  async listOpen(companyId: ID) {
    return clone(this.items.filter((a) => a.companyId === companyId && a.status === "open"));
  }
}

class MemEventRepo implements EventRepo {
  constructor(private readonly items: EventRecordEntity[]) {}
  async append(event: EventRecordEntity) {
    this.items.push(clone(event));
  }
  async list(companyId: ID, type?: string) {
    return clone(
      this.items.filter((e) => e.companyId === companyId && (!type || e.type === type))
    );
  }
  async listPage(companyId: ID, query: { offset?: number; limit?: number; type?: string }) {
    const filtered = this.items
      .filter((e) => e.companyId === companyId && (!query.type || e.type === query.type))
      .sort((a, b) =>
        a.occurredAt !== b.occurredAt
          ? a.occurredAt > b.occurredAt
            ? -1
            : 1
          : a.id > b.id
            ? -1
            : 1
      );
    return paginate(filtered, query);
  }
}

class MemSkillExecutionRepo implements SkillExecutionRepo {
  constructor(private readonly items: SkillExecution[]) {}
  async create(entity: SkillExecution) {
    this.items.push(clone(entity));
    return clone(entity);
  }
  async list(companyId: ID, skill?: string) {
    return clone(
      this.items.filter((e) => e.companyId === companyId && (!skill || e.skill === skill))
    );
  }
}

/** Append-only: não há update nem delete — imutabilidade da trilha. */
class MemAuditRepo implements AuditRepo {
  constructor(
    private readonly items: AuditRecord[],
    private readonly heads: AuditHead[]
  ) {}
  async getHead(companyId: ID) {
    const head = this.heads.find((h) => h.companyId === companyId);
    return head ? { ...head } : null;
  }
  async setHead(head: AuditHead) {
    const idx = this.heads.findIndex((h) => h.companyId === head.companyId);
    if (idx >= 0) this.heads[idx] = { ...head };
    else this.heads.push({ ...head });
  }
  async append(record: AuditRecord) {
    // Espelha o unique (companyId, seq) do Postgres: rejeita seq duplicado por
    // empresa (evita bifurcar a cadeia sob concorrência também no modo demo).
    if (this.items.some((r) => r.companyId === record.companyId && r.seq === record.seq)) {
      throw new ValidationError(
        `Sequência de auditoria ${record.seq} já usada para a empresa ${record.companyId}.`
      );
    }
    this.items.push(clone(record));
  }
  async last(companyId: ID) {
    const filtered = this.items.filter((r) => r.companyId === companyId);
    if (filtered.length === 0) return null;
    return clone(filtered.reduce((a, b) => (a.seq > b.seq ? a : b)));
  }
  async list(companyId: ID, filter?: { entityType?: string; entityId?: ID }) {
    return clone(
      this.items.filter(
        (r) =>
          r.companyId === companyId &&
          (!filter?.entityType || r.entityType === filter.entityType) &&
          (!filter?.entityId || r.entityId === filter.entityId)
      )
    );
  }
  async listPage(
    companyId: ID,
    query: { offset?: number; limit?: number; entityType?: string; entityId?: ID }
  ) {
    const filtered = this.items
      .filter(
        (r) =>
          r.companyId === companyId &&
          (!query.entityType || r.entityType === query.entityType) &&
          (!query.entityId || r.entityId === query.entityId)
      )
      .sort((a, b) => b.seq - a.seq);
    return paginate(filtered, query);
  }
}

class MemCollectionMessageRepo
  extends MemBase<CollectionMessage>
  implements CollectionMessageRepo
{
  async listByStatus(companyId: ID, statuses: CollectionMessageStatus[]) {
    return clone(
      this.items.filter((m) => m.companyId === companyId && statuses.includes(m.status))
    );
  }
}

class MemAccountingEntryRepo extends MemBase<AccountingEntry> implements AccountingEntryRepo {
  async listUnexported(companyId: ID) {
    return clone(this.items.filter((e) => e.companyId === companyId && !e.exported));
  }
  async listByDateRange(companyId: ID, start: ISODate, end: ISODate) {
    return clone(
      this.items.filter(
        (e) => e.companyId === companyId && e.entryDate >= start && e.entryDate <= end
      )
    );
  }
}

class MemFlowRunRepo extends MemBase<FlowRun> implements FlowRunRepo {
  async findByApprovalId(companyId: ID, approvalId: ID) {
    const found = this.items.find(
      (f) => f.companyId === companyId && f.approvalId === approvalId
    );
    return found ? clone(found) : null;
  }
}

class MemIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly items: IdempotencyRecord[]) {}
  async findByKey(companyId: ID, key: string) {
    const found = this.items.find((r) => r.companyId === companyId && r.key === key);
    return found ? clone(found) : null;
  }
  /** Upsert por (companyId, key) — um fluxo pode salvar na suspensão e na conclusão. */
  async save(record: IdempotencyRecord) {
    const idx = this.items.findIndex(
      (r) => r.companyId === record.companyId && r.key === record.key
    );
    if (idx >= 0) this.items[idx] = clone(record);
    else this.items.push(clone(record));
  }
  /** Insert-if-absent atômico (single-thread): serializa execuções concorrentes. */
  async reserve(record: IdempotencyRecord) {
    const existing = this.items.find(
      (r) => r.companyId === record.companyId && r.key === record.key
    );
    if (existing) return { reserved: false, existing: clone(existing) };
    this.items.push(clone(record));
    return { reserved: true };
  }
  async remove(companyId: ID, key: string) {
    const idx = this.items.findIndex((r) => r.companyId === companyId && r.key === key);
    if (idx >= 0) this.items.splice(idx, 1);
  }
}

export function createMemoryRepositories(db: MemoryDb): Repositories {
  const repos: Repositories = {
    companies: new MemCompanyRepo(db.companies),
    users: new MemUserRepo(db.users),
    memberships: new MemMembershipRepo(db.memberships),
    customers: new MemBase(db.customers),
    suppliers: new MemSupplierRepo(db.suppliers),
    supplierCategories: new MemBase(db.supplierCategories),
    bankAccounts: new MemBase(db.bankAccounts),
    bankTransactions: new MemBankTransactionRepo(db.bankTransactions),
    payables: new MemPayableRepo(db.payables),
    receivables: new MemReceivableRepo(db.receivables),
    payments: new MemPaymentRepo(db.payments),
    receipts: new MemReceiptRepo(db.receipts),
    documents: new MemDocumentRepo(db.documents),
    categories: new MemBase(db.categories),
    costCenters: new MemBase(db.costCenters),
    chartAccounts: new MemBase(db.chartAccounts),
    budgets: new MemBase(db.budgets),
    budgetLines: new MemBudgetLineRepo(db.budgetLines),
    approvals: new MemApprovalRepo(db.approvals),
    reconciliations: new MemReconciliationRepo(db.reconciliations),
    alerts: new MemAlertRepo(db.alerts),
    events: new MemEventRepo(db.events),
    skillExecutions: new MemSkillExecutionRepo(db.skillExecutions),
    audit: new MemAuditRepo(db.auditRecords, db.auditHeads),
    invoices: new MemBase(db.invoices),
    collectionMessages: new MemCollectionMessageRepo(db.collectionMessages),
    accountingEntries: new MemAccountingEntryRepo(db.accountingEntries),
    flowRuns: new MemFlowRunRepo(db.flowRuns),
    idempotency: new MemIdempotencyRepo(db.idempotencyRecords),
    async withTransaction<T>(fn: (txRepos: Repositories) => Promise<T>): Promise<T> {
      // Transação em memória (single-thread): snapshot do conteúdo de cada tabela;
      // em caso de erro, restaura tudo no lugar (os repos apontam para os mesmos
      // arrays, então a restauração desfaz as escritas). Sem isolamento entre
      // transações concorrentes — suficiente para demo/testes.
      const arrays = Object.values(db).filter((v): v is unknown[] => Array.isArray(v));
      const snapshots = arrays.map((arr) => arr.map((item) => clone(item)));
      try {
        return await fn(repos);
      } catch (error) {
        arrays.forEach((arr, i) => {
          arr.length = 0;
          arr.push(...snapshots[i]);
        });
        throw error;
      }
    },
  };
  return repos;
}
