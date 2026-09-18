/**
 * Banco em memória — usado em testes e no MODO DEMO (claramente identificado).
 * NUNCA é fonte oficial em produção; a fonte oficial é o PostgreSQL via Prisma.
 */

import type {
  AccountingEntry,
  ActivityEvent,
  Alert,
  Approval,
  AuditRecord,
  BankAccount,
  BankTransaction,
  StatementImport,
  Budget,
  BudgetLine,
  CashflowCategory,
  CashflowManualEntry,
  CashflowMapping,
  CashflowParameter,
  CashflowScenario,
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

import { seedCashflowCategories } from "@/core/cashflow/plan";

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
  statementImports: StatementImport[] = [];
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
  activityEvents: ActivityEvent[] = [];
  invoices: Invoice[] = [];
  collectionMessages: CollectionMessage[] = [];
  accountingEntries: AccountingEntry[] = [];
  flowRuns: FlowRun[] = [];
  idempotencyRecords: IdempotencyRecord[] = [];
  // Fluxo de Caixa: o plano de categorias já vem semeado (referência global).
  cashflowCategories: CashflowCategory[] = seedCashflowCategories();
  cashflowMappings: CashflowMapping[] = [];
  cashflowParameters: CashflowParameter[] = [];
  cashflowScenarios: CashflowScenario[] = [];
  cashflowManualEntries: CashflowManualEntry[] = [];
  /** Âncora do head da trilha por empresa (chave: companyId). */
  auditHeads: Array<{ companyId: string; seq: number; hash: string }> = [];
}
