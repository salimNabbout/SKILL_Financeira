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
  User,
} from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import type {
  AccountingEntryRepo,
  AlertRepo,
  ApprovalRepo,
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
  UserRepo,
} from "@/core/repositories";
import type { MemoryDb } from "./db";

const clone = <T>(value: T): T => structuredClone(value);

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
  constructor(private readonly items: AuditRecord[]) {}
  async append(record: AuditRecord) {
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
}

export function createMemoryRepositories(db: MemoryDb): Repositories {
  return {
    companies: new MemCompanyRepo(db.companies),
    users: new MemUserRepo(db.users),
    memberships: new MemMembershipRepo(db.memberships),
    customers: new MemBase(db.customers),
    suppliers: new MemBase(db.suppliers),
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
    audit: new MemAuditRepo(db.auditRecords),
    invoices: new MemBase(db.invoices),
    collectionMessages: new MemCollectionMessageRepo(db.collectionMessages),
    accountingEntries: new MemAccountingEntryRepo(db.accountingEntries),
    flowRuns: new MemFlowRunRepo(db.flowRuns),
    idempotency: new MemIdempotencyRepo(db.idempotencyRecords),
  };
}
