/**
 * Banco em memória — usado em testes e no MODO DEMO (claramente identificado).
 * NUNCA é fonte oficial em produção; a fonte oficial é o PostgreSQL via Prisma.
 */

import type {
  AccountingEntry,
  Alert,
  Approval,
  AuditRecord,
  BankAccount,
  BankTransaction,
  Budget,
  BudgetLine,
  Category,
  ChartAccount,
  CollectionMessage,
  Company,
  CostCenter,
  Customer,
  EventRecordEntity,
  FinancialDocument,
  FlowRun,
  IdempotencyRecord,
  Invoice,
  Membership,
  Payable,
  Payment,
  Receipt,
  Receivable,
  ReconciliationMatch,
  RecurringTemplate,
  SkillExecution,
  Supplier,
  SupplierCategory,
  User,
} from "@/core/entities";

export class MemoryDb {
  companies: Company[] = [];
  users: User[] = [];
  memberships: Membership[] = [];
  customers: Customer[] = [];
  suppliers: Supplier[] = [];
  supplierCategories: SupplierCategory[] = [];
  recurringTemplates: RecurringTemplate[] = [];
  bankAccounts: BankAccount[] = [];
  bankTransactions: BankTransaction[] = [];
  payables: Payable[] = [];
  receivables: Receivable[] = [];
  payments: Payment[] = [];
  receipts: Receipt[] = [];
  documents: FinancialDocument[] = [];
  categories: Category[] = [];
  costCenters: CostCenter[] = [];
  chartAccounts: ChartAccount[] = [];
  budgets: Budget[] = [];
  budgetLines: BudgetLine[] = [];
  approvals: Approval[] = [];
  reconciliations: ReconciliationMatch[] = [];
  events: EventRecordEntity[] = [];
  alerts: Alert[] = [];
  skillExecutions: SkillExecution[] = [];
  auditRecords: AuditRecord[] = [];
  invoices: Invoice[] = [];
  collectionMessages: CollectionMessage[] = [];
  accountingEntries: AccountingEntry[] = [];
  flowRuns: FlowRun[] = [];
  idempotencyRecords: IdempotencyRecord[] = [];
  /** Âncora do head da trilha por empresa (chave: companyId). */
  auditHeads: Array<{ companyId: string; seq: number; hash: string }> = [];
}
