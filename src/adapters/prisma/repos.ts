/**
 * Adaptador Prisma/PostgreSQL — implementa todas as interfaces de
 * src/core/repositories.ts sobre os modelos de prisma/schema.prisma.
 *
 * Conversões na borda (o domínio nunca vê tipos do banco):
 * - BigInt (banco) <-> number em centavos (domínio);
 * - DateTime @db.Date <-> ISODate "YYYY-MM-DD";
 * - DateTime <-> string ISO-8601 completa;
 * - Json <-> unknown (configJson->config, payloadJson->payload, ...);
 * - null (banco) <-> undefined (domínio) para campos opcionais.
 */

import type {
  AccountingEntry as DbAccountingEntry,
  ActivityEvent as DbActivityEvent,
  Alert as DbAlert,
  Approval as DbApproval,
  AuditRecord as DbAuditRecord,
  BankAccount as DbBankAccount,
  BankTransaction as DbBankTransaction,
  Budget as DbBudget,
  BudgetLine as DbBudgetLine,
  Category as DbCategory,
  ChartAccount as DbChartAccount,
  CollectionMessage as DbCollectionMessage,
  Company as DbCompany,
  CostCenter as DbCostCenter,
  Customer as DbCustomer,
  EventRecord as DbEventRecord,
  FinancialDocument as DbFinancialDocument,
  FlowRun as DbFlowRun,
  IdempotencyRecord as DbIdempotencyRecord,
  Invoice as DbInvoice,
  Membership as DbMembership,
  Payable as DbPayable,
  Payment as DbPayment,
  PrismaClient,
  Receipt as DbReceipt,
  Receivable as DbReceivable,
  ReconciliationMatch as DbReconciliationMatch,
  RecurringTemplate as DbRecurringTemplate,
  SkillExecution as DbSkillExecution,
  Supplier as DbSupplier,
  SupplierCategory as DbSupplierCategory,
  User as DbUser,
} from "@prisma/client";
import { Prisma } from "@prisma/client";

import type { ISODate } from "@/core/dates";
import type {
  AccountingEntry,
  ActivityEvent,
  Alert,
  Approval,
  ApprovalStatus,
  AuditRecord,
  BankAccount,
  BankTransaction,
  StatementImport,
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
  RecurringTemplate,
  SkillExecution,
  Supplier,
  SupplierCategory,
  User,
} from "@/core/entities";
import type {
  AccountingEntryRepo,
  ActivityEventRepo,
  AlertRepo,
  ApprovalRepo,
  AuditHead,
  AuditRepo,
  BankAccountRepo,
  BankTransactionRepo,
  StatementImportRepo,
  BudgetLineRepo,
  BudgetRepo,
  CategoryRepo,
  ChartAccountRepo,
  CollectionMessageRepo,
  CompanyRepo,
  CostCenterRepo,
  CustomerRepo,
  EventRepo,
  FinancialDocumentRepo,
  FlowRunRepo,
  IdempotencyRepo,
  InvoiceRepo,
  MembershipRepo,
  PayableRepo,
  PaymentRepo,
  ReceiptRepo,
  ReceivableRepo,
  ReconciliationRepo,
  RecurringTemplateRepo,
  Repositories,
  SkillExecutionRepo,
  SupplierRepo,
  SupplierCategoryRepo,
  UserRepo,
} from "@/core/repositories";

// ---------------------------------------------------------------------------
// Helpers de conversão (borda banco <-> domínio)
// ---------------------------------------------------------------------------

/** BigInt (banco) -> number de centavos (domínio). Seguro até ~90 trilhões de centavos. */
/** offset/limit com defaults e pisos — mesma semântica do adaptador em memória. */
const pageArgs = (q: { offset?: number; limit?: number }): { skip: number; take: number } => ({
  skip: Math.max(0, q.offset ?? 0),
  take: Math.max(1, q.limit ?? 50),
});

const fromCents = (v: bigint): number => Number(v);
const toCents = (v: number): bigint => BigInt(v);
const fromCentsOpt = (v: bigint | null): number | undefined =>
  v == null ? undefined : Number(v);
const toCentsOpt = (v: number | undefined | null): bigint | null =>
  v == null ? null : BigInt(v);

/** DateTime @db.Date (banco) <-> ISODate "YYYY-MM-DD" (domínio). */
const fromDbDate = (d: Date): ISODate => d.toISOString().slice(0, 10);
const toDbDate = (iso: ISODate): Date => new Date(`${iso}T00:00:00Z`);
const fromDbDateOpt = (d: Date | null): ISODate | undefined =>
  d == null ? undefined : fromDbDate(d);
const toDbDateOpt = (iso: ISODate | undefined): Date | null =>
  iso == null ? null : toDbDate(iso);

/** DateTime (banco) <-> string ISO-8601 completa (domínio). */
const fromInstant = (d: Date): string => d.toISOString();
const toInstant = (iso: string): Date => new Date(iso);
const fromInstantOpt = (d: Date | null): string | undefined =>
  d == null ? undefined : d.toISOString();
const toInstantOpt = (iso: string | undefined): Date | null =>
  iso == null ? null : new Date(iso);

/** Json obrigatório: undefined/null do domínio vira JSON null no banco. */
const toJson = (v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  v == null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);

/** Json opcional: undefined/null do domínio vira NULL (SQL) no banco. */
const toJsonOpt = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

const fromJson = (v: Prisma.JsonValue): unknown => v;
const fromJsonOpt = (v: Prisma.JsonValue | null): unknown =>
  v === null ? undefined : v;
const fromJsonArray = (v: Prisma.JsonValue): unknown[] => (Array.isArray(v) ? v : []);

const strOpt = (v: string | null): string | undefined => v ?? undefined;
const strNull = (v: string | undefined): string | null => v ?? null;

// ---------------------------------------------------------------------------
// Mapeadores por entidade
// ---------------------------------------------------------------------------

const companyToDomain = (r: DbCompany): Company => ({
  id: r.id,
  name: r.name,
  legalName: strOpt(r.legalName),
  cnpj: r.cnpj,
  timezone: r.timezone,
  defaultCurrency: r.defaultCurrency as Company["defaultCurrency"],
  config: fromJson(r.configJson),
  active: r.active,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const companyToDb = (e: Company): Prisma.CompanyCreateInput => ({
  id: e.id,
  name: e.name,
  legalName: strNull(e.legalName),
  cnpj: e.cnpj,
  timezone: e.timezone,
  defaultCurrency: e.defaultCurrency,
  configJson: toJson(e.config ?? {}),
  active: e.active,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const userToDomain = (r: DbUser): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  passwordHash: r.passwordHash,
  totpSecret: strOpt(r.totpSecret),
  totpEnabled: r.totpEnabled,
  totpLastCounter: r.totpLastCounter ?? undefined,
  active: r.active,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const userToDb = (e: User): Prisma.UserCreateInput => ({
  id: e.id,
  name: e.name,
  email: e.email,
  passwordHash: e.passwordHash,
  totpSecret: strNull(e.totpSecret),
  totpEnabled: e.totpEnabled ?? false,
  totpLastCounter: e.totpLastCounter ?? null,
  active: e.active,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const membershipToDomain = (r: DbMembership): Membership => ({
  id: r.id,
  userId: r.userId,
  companyId: r.companyId,
  role: r.role as Membership["role"],
  approvalLimitCents: r.approvalLimitCents == null ? null : Number(r.approvalLimitCents),
});
const membershipToDb = (e: Membership): Prisma.MembershipUncheckedCreateInput => ({
  id: e.id,
  userId: e.userId,
  companyId: e.companyId,
  role: e.role,
  approvalLimitCents: toCentsOpt(e.approvalLimitCents),
});

const customerToDomain = (r: DbCustomer): Customer => ({
  id: r.id,
  companyId: r.companyId,
  name: r.name,
  document: strOpt(r.document),
  email: strOpt(r.email),
  phone: strOpt(r.phone),
  address: strOpt(r.address),
  active: r.active,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const customerToDb = (e: Customer): Prisma.CustomerUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  name: e.name,
  document: strNull(e.document),
  email: strNull(e.email),
  phone: strNull(e.phone),
  address: strNull(e.address),
  active: e.active,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const supplierToDomain = (r: DbSupplier): Supplier => ({
  id: r.id,
  companyId: r.companyId,
  name: r.name,
  document: strOpt(r.document),
  email: strOpt(r.email),
  phone: strOpt(r.phone),
  address: strOpt(r.address),
  costClassification: (strOpt(r.costClassification) as Supplier["costClassification"]) ?? undefined,
  category: strOpt(r.category),
  bankInfoMasked: strOpt(r.bankInfoMasked),
  pixKeyMasked: strOpt(r.pixKeyMasked),
  active: r.active,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const supplierToDb = (e: Supplier): Prisma.SupplierUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  name: e.name,
  document: strNull(e.document),
  email: strNull(e.email),
  phone: strNull(e.phone),
  address: strNull(e.address),
  costClassification: strNull(e.costClassification),
  category: strNull(e.category),
  bankInfoMasked: strNull(e.bankInfoMasked),
  pixKeyMasked: strNull(e.pixKeyMasked),
  active: e.active,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const supplierCategoryToDomain = (r: DbSupplierCategory): SupplierCategory => ({
  id: r.id,
  companyId: r.companyId,
  name: r.name,
  active: r.active,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const supplierCategoryToDb = (e: SupplierCategory): Prisma.SupplierCategoryUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  name: e.name,
  active: e.active,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const recurringTemplateToDomain = (r: DbRecurringTemplate): RecurringTemplate => ({
  id: r.id,
  companyId: r.companyId,
  kind: r.kind as RecurringTemplate["kind"],
  counterpartyId: r.counterpartyId,
  description: r.description,
  amountCents: fromCents(r.amountCents),
  dueDay: r.dueDay,
  category: strOpt(r.category),
  costClassification: (strOpt(r.costClassification) as RecurringTemplate["costClassification"]) ?? undefined,
  startDate: fromDbDate(r.startDate),
  endDate: fromDbDateOpt(r.endDate),
  status: r.status as RecurringTemplate["status"],
  createdBy: r.createdBy,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const recurringTemplateToDb = (
  e: RecurringTemplate
): Prisma.RecurringTemplateUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  kind: e.kind,
  counterpartyId: e.counterpartyId,
  description: e.description,
  amountCents: toCents(e.amountCents),
  dueDay: e.dueDay,
  category: strNull(e.category),
  costClassification: strNull(e.costClassification),
  startDate: toDbDate(e.startDate),
  endDate: toDbDateOpt(e.endDate),
  status: e.status,
  createdBy: e.createdBy,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const bankAccountToDomain = (r: DbBankAccount): BankAccount => ({
  id: r.id,
  companyId: r.companyId,
  name: r.name,
  bankCode: r.bankCode,
  agency: r.agency,
  accountNumberMasked: r.accountNumberMasked,
  type: r.type as BankAccount["type"],
  currency: r.currency as BankAccount["currency"],
  openingBalanceCents: fromCents(r.openingBalanceCents),
  openingBalanceDate: fromDbDate(r.openingBalanceDate),
  active: r.active,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const bankAccountToDb = (e: BankAccount): Prisma.BankAccountUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  name: e.name,
  bankCode: e.bankCode,
  agency: e.agency,
  accountNumberMasked: e.accountNumberMasked,
  type: e.type,
  currency: e.currency,
  openingBalanceCents: toCents(e.openingBalanceCents),
  openingBalanceDate: toDbDate(e.openingBalanceDate),
  active: e.active,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

type StatementImportRow = {
  id: string;
  companyId: string;
  bankAccountId: string;
  format: string;
  source: string;
  imported: number;
  duplicates: number;
  warnings: string[];
  ledgerBalanceCents: bigint | null;
  ledgerBalanceDate: Date | null;
  createdBy: string;
  createdAt: Date;
};

const statementImportToDomain = (r: StatementImportRow): StatementImport => ({
  id: r.id,
  companyId: r.companyId,
  bankAccountId: r.bankAccountId,
  format: r.format,
  source: r.source as StatementImport["source"],
  imported: r.imported,
  duplicates: r.duplicates,
  warnings: r.warnings,
  ledgerBalanceCents: fromCentsOpt(r.ledgerBalanceCents),
  ledgerBalanceDate: fromDbDateOpt(r.ledgerBalanceDate),
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});

const statementImportToDb = (e: StatementImport) => ({
  id: e.id,
  companyId: e.companyId,
  bankAccountId: e.bankAccountId,
  format: e.format,
  source: e.source,
  imported: e.imported,
  duplicates: e.duplicates,
  warnings: e.warnings,
  ledgerBalanceCents: toCentsOpt(e.ledgerBalanceCents),
  ledgerBalanceDate: toDbDateOpt(e.ledgerBalanceDate),
  createdBy: e.createdBy,
  createdAt: new Date(e.createdAt),
});

const bankTransactionToDomain = (r: DbBankTransaction): BankTransaction => ({
  id: r.id,
  companyId: r.companyId,
  bankAccountId: r.bankAccountId,
  date: fromDbDate(r.date),
  amountCents: fromCents(r.amountCents),
  currency: r.currency as BankTransaction["currency"],
  description: r.description,
  externalId: strOpt(r.externalId),
  importBatchId: strOpt(r.importBatchId),
  source: r.source as BankTransaction["source"],
  reconciled: r.reconciled,
  createdAt: fromInstant(r.createdAt),
});
const bankTransactionToDb = (e: BankTransaction): Prisma.BankTransactionUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  bankAccountId: e.bankAccountId,
  date: toDbDate(e.date),
  amountCents: toCents(e.amountCents),
  currency: e.currency,
  description: e.description,
  externalId: strNull(e.externalId),
  importBatchId: strNull(e.importBatchId),
  source: e.source,
  reconciled: e.reconciled,
  createdAt: toInstant(e.createdAt),
});

const payableToDomain = (r: DbPayable): Payable => ({
  id: r.id,
  companyId: r.companyId,
  supplierId: r.supplierId,
  documentId: strOpt(r.documentId),
  description: r.description,
  issueDate: fromDbDate(r.issueDate),
  dueDate: fromDbDate(r.dueDate),
  amountCents: fromCents(r.amountCents),
  paidCents: fromCents(r.paidCents),
  currency: r.currency as Payable["currency"],
  status: r.status as PayableStatus,
  categoryId: strOpt(r.categoryId),
  costCenterId: strOpt(r.costCenterId),
  supplierCategory: strOpt(r.supplierCategory),
  costClassification: (strOpt(r.costClassification) as Payable["costClassification"]) ?? undefined,
  installmentNumber: r.installmentNumber,
  installmentCount: r.installmentCount,
  originKey: r.originKey,
  notes: strOpt(r.notes),
  canceledAt: fromInstantOpt(r.canceledAt),
  createdBy: r.createdBy,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const payableToDb = (e: Payable): Prisma.PayableUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  supplierId: e.supplierId,
  documentId: strNull(e.documentId),
  description: e.description,
  issueDate: toDbDate(e.issueDate),
  dueDate: toDbDate(e.dueDate),
  amountCents: toCents(e.amountCents),
  paidCents: toCents(e.paidCents),
  currency: e.currency,
  status: e.status,
  categoryId: strNull(e.categoryId),
  costCenterId: strNull(e.costCenterId),
  supplierCategory: strNull(e.supplierCategory),
  costClassification: strNull(e.costClassification),
  installmentNumber: e.installmentNumber,
  installmentCount: e.installmentCount,
  originKey: e.originKey,
  notes: strNull(e.notes),
  canceledAt: toInstantOpt(e.canceledAt),
  createdBy: e.createdBy,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const receivableToDomain = (r: DbReceivable): Receivable => ({
  id: r.id,
  companyId: r.companyId,
  customerId: r.customerId,
  invoiceId: strOpt(r.invoiceId),
  documentId: strOpt(r.documentId),
  description: r.description,
  issueDate: fromDbDate(r.issueDate),
  dueDate: fromDbDate(r.dueDate),
  amountCents: fromCents(r.amountCents),
  receivedCents: fromCents(r.receivedCents),
  currency: r.currency as Receivable["currency"],
  status: r.status as ReceivableStatus,
  method: (r.method ?? undefined) as Receivable["method"],
  categoryId: strOpt(r.categoryId),
  costCenterId: strOpt(r.costCenterId),
  installmentNumber: r.installmentNumber,
  installmentCount: r.installmentCount,
  originKey: r.originKey,
  notes: strOpt(r.notes),
  canceledAt: fromInstantOpt(r.canceledAt),
  createdBy: r.createdBy,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const receivableToDb = (e: Receivable): Prisma.ReceivableUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  customerId: e.customerId,
  invoiceId: strNull(e.invoiceId),
  documentId: strNull(e.documentId),
  description: e.description,
  issueDate: toDbDate(e.issueDate),
  dueDate: toDbDate(e.dueDate),
  amountCents: toCents(e.amountCents),
  receivedCents: toCents(e.receivedCents),
  currency: e.currency,
  status: e.status,
  method: strNull(e.method),
  categoryId: strNull(e.categoryId),
  costCenterId: strNull(e.costCenterId),
  installmentNumber: e.installmentNumber,
  installmentCount: e.installmentCount,
  originKey: e.originKey,
  notes: strNull(e.notes),
  canceledAt: toInstantOpt(e.canceledAt),
  createdBy: e.createdBy,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const paymentToDomain = (r: DbPayment): Payment => ({
  id: r.id,
  companyId: r.companyId,
  payableId: r.payableId,
  bankAccountId: r.bankAccountId,
  amountCents: fromCents(r.amountCents),
  scheduledDate: fromDbDate(r.scheduledDate),
  executedAt: fromInstantOpt(r.executedAt),
  status: r.status as PaymentStatus,
  approvalId: strOpt(r.approvalId),
  requestedBy: r.requestedBy,
  executedBy: strOpt(r.executedBy),
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const paymentToDb = (e: Payment): Prisma.PaymentUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  payableId: e.payableId,
  bankAccountId: e.bankAccountId,
  amountCents: toCents(e.amountCents),
  scheduledDate: toDbDate(e.scheduledDate),
  executedAt: toInstantOpt(e.executedAt),
  status: e.status,
  approvalId: strNull(e.approvalId),
  requestedBy: e.requestedBy,
  executedBy: strNull(e.executedBy),
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const receiptToDomain = (r: DbReceipt): Receipt => ({
  id: r.id,
  companyId: r.companyId,
  receivableId: r.receivableId,
  bankAccountId: strOpt(r.bankAccountId),
  amountCents: fromCents(r.amountCents),
  receivedDate: fromDbDate(r.receivedDate),
  method: r.method as Receipt["method"],
  status: r.status as Receipt["status"],
  canceledAt: fromInstantOpt(r.canceledAt),
  principalCents: fromCentsOpt(r.principalCents),
  registeredBy: r.registeredBy,
  createdAt: fromInstant(r.createdAt),
});
const receiptToDb = (e: Receipt): Prisma.ReceiptUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  receivableId: e.receivableId,
  bankAccountId: strNull(e.bankAccountId),
  amountCents: toCents(e.amountCents),
  receivedDate: toDbDate(e.receivedDate),
  method: e.method,
  status: e.status ?? "registered",
  canceledAt: toInstantOpt(e.canceledAt),
  principalCents: toCentsOpt(e.principalCents),
  registeredBy: e.registeredBy,
  createdAt: toInstant(e.createdAt),
});

const documentToDomain = (r: DbFinancialDocument): FinancialDocument => ({
  id: r.id,
  companyId: r.companyId,
  type: r.type as FinancialDocument["type"],
  number: r.number,
  series: strOpt(r.series),
  issuerName: r.issuerName,
  issuerDoc: strOpt(r.issuerDoc),
  issuedAt: fromDbDate(r.issuedAt),
  totalCents: fromCents(r.totalCents),
  contentHash: r.contentHash,
  raw: fromJsonOpt(r.rawJson),
  createdAt: fromInstant(r.createdAt),
});
const documentToDb = (e: FinancialDocument): Prisma.FinancialDocumentUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  type: e.type,
  number: e.number,
  series: strNull(e.series),
  issuerName: e.issuerName,
  issuerDoc: strNull(e.issuerDoc),
  issuedAt: toDbDate(e.issuedAt),
  totalCents: toCents(e.totalCents),
  contentHash: e.contentHash,
  rawJson: toJsonOpt(e.raw),
  createdAt: toInstant(e.createdAt),
});

const categoryToDomain = (r: DbCategory): Category => ({
  id: r.id,
  companyId: r.companyId,
  name: r.name,
  kind: r.kind as Category["kind"],
  dreGroup: r.dreGroup as Category["dreGroup"],
  parentId: strOpt(r.parentId),
  active: r.active,
});
const categoryToDb = (e: Category): Prisma.CategoryUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  name: e.name,
  kind: e.kind,
  dreGroup: e.dreGroup,
  parentId: strNull(e.parentId),
  active: e.active,
});

const costCenterToDomain = (r: DbCostCenter): CostCenter => ({
  id: r.id,
  companyId: r.companyId,
  code: r.code,
  name: r.name,
  active: r.active,
  // Coluna criada com default "both" (migração 0015): linhas anteriores já vêm
  // preenchidas, e o fallback cobre bancos ainda não migrados.
  scope: (r.scope as CostCenter["scope"]) ?? "both",
});
const costCenterToDb = (e: CostCenter): Prisma.CostCenterUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  code: e.code,
  name: e.name,
  active: e.active,
  scope: e.scope,
});

const chartAccountToDomain = (r: DbChartAccount): ChartAccount => ({
  id: r.id,
  companyId: r.companyId,
  code: r.code,
  name: r.name,
  type: r.type as ChartAccount["type"],
  parentCode: strOpt(r.parentCode),
  active: r.active,
});
const chartAccountToDb = (e: ChartAccount): Prisma.ChartAccountUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  code: e.code,
  name: e.name,
  type: e.type,
  parentCode: strNull(e.parentCode),
  active: e.active,
});

const budgetToDomain = (r: DbBudget): Budget => ({
  id: r.id,
  companyId: r.companyId,
  name: r.name,
  year: r.year,
  status: r.status as Budget["status"],
  createdAt: fromInstant(r.createdAt),
});
const budgetToDb = (e: Budget): Prisma.BudgetUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  name: e.name,
  year: e.year,
  status: e.status,
  createdAt: toInstant(e.createdAt),
});

const budgetLineToDomain = (r: DbBudgetLine): BudgetLine => ({
  id: r.id,
  budgetId: r.budgetId,
  period: r.period,
  categoryId: strOpt(r.categoryId),
  costCenterId: strOpt(r.costCenterId),
  amountCents: fromCents(r.amountCents),
});
const budgetLineToDb = (e: BudgetLine): Prisma.BudgetLineUncheckedCreateInput => ({
  id: e.id,
  budgetId: e.budgetId,
  period: e.period,
  categoryId: strNull(e.categoryId),
  costCenterId: strNull(e.costCenterId),
  amountCents: toCents(e.amountCents),
});

const approvalToDomain = (r: DbApproval): Approval => ({
  id: r.id,
  companyId: r.companyId,
  targetType: r.targetType as Approval["targetType"],
  targetId: r.targetId,
  flowRunId: strOpt(r.flowRunId),
  summary: r.summary,
  amountCents: fromCentsOpt(r.amountCents),
  requestedBy: r.requestedBy,
  requiredRole: r.requiredRole as Approval["requiredRole"],
  approvalsRequired: r.approvalsRequired,
  approverIds: r.approverIds,
  status: r.status as ApprovalStatus,
  decidedBy: strOpt(r.decidedBy),
  decidedAt: fromInstantOpt(r.decidedAt),
  justification: strOpt(r.justification),
  version: r.version,
  revertedAt: fromInstantOpt(r.revertedAt),
  createdAt: fromInstant(r.createdAt),
});
const approvalToDb = (e: Approval): Prisma.ApprovalUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  targetType: e.targetType,
  targetId: e.targetId,
  flowRunId: strNull(e.flowRunId),
  summary: e.summary,
  amountCents: toCentsOpt(e.amountCents),
  requestedBy: e.requestedBy,
  requiredRole: e.requiredRole,
  approvalsRequired: e.approvalsRequired ?? 1,
  approverIds: e.approverIds ?? [],
  status: e.status,
  decidedBy: strNull(e.decidedBy),
  decidedAt: toInstantOpt(e.decidedAt),
  justification: strNull(e.justification),
  version: e.version ?? 0,
  revertedAt: toInstantOpt(e.revertedAt),
  createdAt: toInstant(e.createdAt),
});

const reconciliationToDomain = (r: DbReconciliationMatch): ReconciliationMatch => ({
  id: r.id,
  companyId: r.companyId,
  bankTransactionId: r.bankTransactionId,
  targetType: r.targetType as ReconciliationMatch["targetType"],
  targetId: strOpt(r.targetId),
  amountCents: fromCentsOpt(r.amountCents),
  groupId: strOpt(r.groupId),
  confidence: r.confidence,
  status: r.status as ReconciliationStatus,
  matchedBy: r.matchedBy,
  notes: strOpt(r.notes),
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const reconciliationToDb = (
  e: ReconciliationMatch
): Prisma.ReconciliationMatchUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  bankTransactionId: e.bankTransactionId,
  targetType: e.targetType,
  targetId: strNull(e.targetId),
  amountCents: toCentsOpt(e.amountCents),
  groupId: strNull(e.groupId),
  confidence: e.confidence,
  status: e.status,
  matchedBy: e.matchedBy,
  notes: strNull(e.notes),
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const eventToDomain = (r: DbEventRecord): EventRecordEntity => ({
  id: r.id,
  companyId: r.companyId,
  type: r.type,
  payload: fromJson(r.payloadJson),
  source: r.source,
  correlationId: r.correlationId,
  causationId: strOpt(r.causationId),
  occurredAt: fromInstant(r.occurredAt),
});
const eventToDb = (e: EventRecordEntity): Prisma.EventRecordUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  type: e.type,
  payloadJson: toJson(e.payload),
  source: e.source,
  correlationId: e.correlationId,
  causationId: strNull(e.causationId),
  occurredAt: toInstant(e.occurredAt),
});

const alertToDomain = (r: DbAlert): Alert => ({
  id: r.id,
  companyId: r.companyId,
  severity: r.severity as Alert["severity"],
  code: r.code,
  message: r.message,
  entityType: strOpt(r.entityType),
  entityId: strOpt(r.entityId),
  source: r.source,
  status: r.status as Alert["status"],
  createdAt: fromInstant(r.createdAt),
  resolvedAt: fromInstantOpt(r.resolvedAt),
});
const alertToDb = (e: Alert): Prisma.AlertUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  severity: e.severity,
  code: e.code,
  message: e.message,
  entityType: strNull(e.entityType),
  entityId: strNull(e.entityId),
  source: e.source,
  status: e.status,
  createdAt: toInstant(e.createdAt),
  resolvedAt: toInstantOpt(e.resolvedAt),
});

const skillExecutionToDomain = (r: DbSkillExecution): SkillExecution => ({
  id: r.id,
  companyId: r.companyId,
  flowRunId: strOpt(r.flowRunId),
  skill: r.skill,
  action: r.action,
  inputHash: r.inputHash,
  status: r.status as SkillExecution["status"],
  confidence: r.confidence,
  result: fromJson(r.resultJson),
  startedAt: fromInstant(r.startedAt),
  finishedAt: fromInstant(r.finishedAt),
});
const skillExecutionToDb = (e: SkillExecution): Prisma.SkillExecutionUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  flowRunId: strNull(e.flowRunId),
  skill: e.skill,
  action: e.action,
  inputHash: e.inputHash,
  status: e.status,
  confidence: e.confidence,
  resultJson: toJson(e.result),
  startedAt: toInstant(e.startedAt),
  finishedAt: toInstant(e.finishedAt),
});

const auditToDomain = (r: DbAuditRecord): AuditRecord => ({
  id: r.id,
  companyId: r.companyId,
  seq: r.seq,
  actorType: r.actorType as AuditRecord["actorType"],
  actorId: r.actorId,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId,
  before: fromJsonOpt(r.beforeJson),
  after: fromJsonOpt(r.afterJson),
  correlationId: strOpt(r.correlationId),
  timestamp: fromInstant(r.timestamp),
  prevHash: r.prevHash,
  hash: r.hash,
});
const auditToDb = (e: AuditRecord): Prisma.AuditRecordUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  seq: e.seq,
  actorType: e.actorType,
  actorId: e.actorId,
  action: e.action,
  entityType: e.entityType,
  entityId: e.entityId,
  beforeJson: toJsonOpt(e.before),
  afterJson: toJsonOpt(e.after),
  correlationId: strNull(e.correlationId),
  timestamp: toInstant(e.timestamp),
  prevHash: e.prevHash,
  hash: e.hash,
});

const activityToDomain = (r: DbActivityEvent): ActivityEvent => ({
  id: r.id,
  companyId: r.companyId,
  userId: strOpt(r.userId),
  origin: r.origin as ActivityEvent["origin"],
  eventType: r.eventType,
  screen: strOpt(r.screen),
  method: strOpt(r.method),
  path: strOpt(r.path),
  status: r.status ?? undefined,
  durationMs: r.durationMs ?? undefined,
  ip: strOpt(r.ip),
  userAgent: strOpt(r.userAgent),
  label: strOpt(r.label),
  elementId: strOpt(r.elementId),
  details: fromJsonOpt(r.detailsJson),
  timestamp: fromInstant(r.timestamp),
});
const activityToDb = (e: ActivityEvent): Prisma.ActivityEventUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  userId: strNull(e.userId),
  origin: e.origin,
  eventType: e.eventType,
  screen: strNull(e.screen),
  method: strNull(e.method),
  path: strNull(e.path),
  status: e.status ?? null,
  durationMs: e.durationMs ?? null,
  ip: strNull(e.ip),
  userAgent: strNull(e.userAgent),
  label: strNull(e.label),
  elementId: strNull(e.elementId),
  detailsJson: toJsonOpt(e.details),
  timestamp: toInstant(e.timestamp),
});

const invoiceToDomain = (r: DbInvoice): Invoice => ({
  id: r.id,
  companyId: r.companyId,
  customerId: r.customerId,
  saleRef: strOpt(r.saleRef),
  description: r.description,
  totalCents: fromCents(r.totalCents),
  issueDate: fromDbDateOpt(r.issueDate),
  status: r.status as Invoice["status"],
  nfeMock:
    r.nfeMockJson === null ? undefined : (r.nfeMockJson as unknown as Invoice["nfeMock"]),
  createdBy: r.createdBy,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const invoiceToDb = (e: Invoice): Prisma.InvoiceUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  customerId: e.customerId,
  saleRef: strNull(e.saleRef),
  description: e.description,
  totalCents: toCents(e.totalCents),
  issueDate: toDbDateOpt(e.issueDate),
  status: e.status,
  nfeMockJson: toJsonOpt(e.nfeMock),
  createdBy: e.createdBy,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const collectionMessageToDomain = (r: DbCollectionMessage): CollectionMessage => ({
  id: r.id,
  companyId: r.companyId,
  receivableId: r.receivableId,
  customerId: r.customerId,
  step: r.step,
  channel: r.channel as CollectionMessage["channel"],
  subject: r.subject,
  body: r.body,
  status: r.status as CollectionMessageStatus,
  approvalId: strOpt(r.approvalId),
  sentAt: fromInstantOpt(r.sentAt),
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const collectionMessageToDb = (
  e: CollectionMessage
): Prisma.CollectionMessageUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  receivableId: e.receivableId,
  customerId: e.customerId,
  step: e.step,
  channel: e.channel,
  subject: e.subject,
  body: e.body,
  status: e.status,
  approvalId: strNull(e.approvalId),
  sentAt: toInstantOpt(e.sentAt),
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const accountingEntryToDomain = (r: DbAccountingEntry): AccountingEntry => ({
  id: r.id,
  companyId: r.companyId,
  entryDate: fromDbDate(r.entryDate),
  debitAccount: r.debitAccount,
  creditAccount: r.creditAccount,
  amountCents: fromCents(r.amountCents),
  memo: r.memo,
  sourceType: r.sourceType as AccountingEntry["sourceType"],
  sourceId: r.sourceId,
  exportBatchId: strOpt(r.exportBatchId),
  exported: r.exported,
  createdAt: fromInstant(r.createdAt),
});
const accountingEntryToDb = (e: AccountingEntry): Prisma.AccountingEntryUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  entryDate: toDbDate(e.entryDate),
  debitAccount: e.debitAccount,
  creditAccount: e.creditAccount,
  amountCents: toCents(e.amountCents),
  memo: e.memo,
  sourceType: e.sourceType,
  sourceId: e.sourceId,
  exportBatchId: strNull(e.exportBatchId),
  exported: e.exported,
  createdAt: toInstant(e.createdAt),
});

const flowRunToDomain = (r: DbFlowRun): FlowRun => ({
  id: r.id,
  companyId: r.companyId,
  flow: r.flow,
  status: r.status as FlowRun["status"],
  cursor: r.cursor,
  payload: fromJson(r.payloadJson),
  results: fromJsonArray(r.resultsJson),
  approvalId: strOpt(r.approvalId),
  idempotencyKey: r.idempotencyKey,
  correlationId: r.correlationId,
  requestedBy: r.requestedBy,
  createdAt: fromInstant(r.createdAt),
  updatedAt: fromInstant(r.updatedAt),
});
const flowRunToDb = (e: FlowRun): Prisma.FlowRunUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  flow: e.flow,
  status: e.status,
  cursor: e.cursor,
  payloadJson: toJson(e.payload),
  resultsJson: toJson(e.results),
  approvalId: strNull(e.approvalId),
  idempotencyKey: e.idempotencyKey,
  correlationId: e.correlationId,
  requestedBy: e.requestedBy,
  createdAt: toInstant(e.createdAt),
  updatedAt: toInstant(e.updatedAt),
});

const idempotencyToDomain = (r: DbIdempotencyRecord): IdempotencyRecord => ({
  id: r.id,
  companyId: r.companyId,
  key: r.key,
  requestHash: r.requestHash,
  result: fromJson(r.resultJson),
  createdAt: fromInstant(r.createdAt),
});
const idempotencyToDb = (e: IdempotencyRecord): Prisma.IdempotencyRecordUncheckedCreateInput => ({
  id: e.id,
  companyId: e.companyId,
  key: e.key,
  requestHash: e.requestHash,
  resultJson: toJson(e.result),
  createdAt: toInstant(e.createdAt),
});

// ---------------------------------------------------------------------------
// Fábrica de repositórios
// ---------------------------------------------------------------------------

/** Cliente Prisma completo OU cliente de transação (subconjunto com os modelos). */
type PrismaLike = PrismaClient | Prisma.TransactionClient;

export function createPrismaRepositories(prisma: PrismaLike): Repositories {
  const companies: CompanyRepo = {
    async getById(id: ID) {
      const row = await prisma.company.findUnique({ where: { id } });
      return row ? companyToDomain(row) : null;
    },
    async findByCnpj(cnpj: string) {
      const row = await prisma.company.findUnique({ where: { cnpj } });
      return row ? companyToDomain(row) : null;
    },
    async listAll() {
      const rows = await prisma.company.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map(companyToDomain);
    },
    async create(entity: Company) {
      const row = await prisma.company.create({ data: companyToDb(entity) });
      return companyToDomain(row);
    },
    async update(entity: Company) {
      const row = await prisma.company.update({
        where: { id: entity.id },
        data: companyToDb(entity),
      });
      return companyToDomain(row);
    },
  };

  const users: UserRepo = {
    async getById(id: ID) {
      const row = await prisma.user.findUnique({ where: { id } });
      return row ? userToDomain(row) : null;
    },
    async findByEmail(email: string) {
      // Paridade com o adaptador em memória: e-mail é comparado sem diferenciar caixa.
      const row = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
      });
      return row ? userToDomain(row) : null;
    },
    async listAll() {
      const rows = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map(userToDomain);
    },
    async create(entity: User) {
      const row = await prisma.user.create({ data: userToDb(entity) });
      return userToDomain(row);
    },
    async update(entity: User) {
      const row = await prisma.user.update({
        where: { id: entity.id },
        data: userToDb(entity),
      });
      return userToDomain(row);
    },
  };

  const memberships: MembershipRepo = {
    async listByUser(userId: ID) {
      const rows = await prisma.membership.findMany({
        where: { userId },
        orderBy: { id: "asc" },
      });
      return rows.map(membershipToDomain);
    },
    async listByCompany(companyId: ID) {
      const rows = await prisma.membership.findMany({
        where: { companyId },
        orderBy: { id: "asc" },
      });
      return rows.map(membershipToDomain);
    },
    async findByUserAndCompany(userId: ID, companyId: ID) {
      const row = await prisma.membership.findUnique({
        where: { userId_companyId: { userId, companyId } },
      });
      return row ? membershipToDomain(row) : null;
    },
    async create(entity: Membership) {
      const row = await prisma.membership.create({ data: membershipToDb(entity) });
      return membershipToDomain(row);
    },
    async update(entity: Membership) {
      const row = await prisma.membership.update({
        where: { id: entity.id },
        data: membershipToDb(entity),
      });
      return membershipToDomain(row);
    },
  };

  const customers: CustomerRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.customer.findFirst({ where: { id, companyId } });
      return row ? customerToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.customer.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(customerToDomain);
    },
    async create(entity: Customer) {
      const row = await prisma.customer.create({ data: customerToDb(entity) });
      return customerToDomain(row);
    },
    async update(entity: Customer) {
      const row = await prisma.customer.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: customerToDb(entity),
      });
      return customerToDomain(row);
    },
  };

  const suppliers: SupplierRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.supplier.findFirst({ where: { id, companyId } });
      return row ? supplierToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.supplier.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(supplierToDomain);
    },
    async create(entity: Supplier) {
      const row = await prisma.supplier.create({ data: supplierToDb(entity) });
      return supplierToDomain(row);
    },
    async update(entity: Supplier) {
      const row = await prisma.supplier.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: supplierToDb(entity),
      });
      return supplierToDomain(row);
    },
    async delete(companyId: ID, id: ID) {
      await prisma.supplier.deleteMany({ where: { id, companyId } });
    },
  };

  const supplierCategories: SupplierCategoryRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.supplierCategory.findFirst({ where: { id, companyId } });
      return row ? supplierCategoryToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.supplierCategory.findMany({
        where: { companyId },
        orderBy: { name: "asc" },
      });
      return rows.map(supplierCategoryToDomain);
    },
    async create(entity: SupplierCategory) {
      const row = await prisma.supplierCategory.create({ data: supplierCategoryToDb(entity) });
      return supplierCategoryToDomain(row);
    },
    async update(entity: SupplierCategory) {
      const row = await prisma.supplierCategory.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: supplierCategoryToDb(entity),
      });
      return supplierCategoryToDomain(row);
    },
  };

  const recurringTemplates: RecurringTemplateRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.recurringTemplate.findFirst({ where: { id, companyId } });
      return row ? recurringTemplateToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.recurringTemplate.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(recurringTemplateToDomain);
    },
    async listActive(companyId: ID) {
      const rows = await prisma.recurringTemplate.findMany({
        where: { companyId, status: "active" },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(recurringTemplateToDomain);
    },
    async create(entity: RecurringTemplate) {
      const row = await prisma.recurringTemplate.create({ data: recurringTemplateToDb(entity) });
      return recurringTemplateToDomain(row);
    },
    async update(entity: RecurringTemplate) {
      const row = await prisma.recurringTemplate.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: recurringTemplateToDb(entity),
      });
      return recurringTemplateToDomain(row);
    },
  };

  const bankAccounts: BankAccountRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.bankAccount.findFirst({ where: { id, companyId } });
      return row ? bankAccountToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.bankAccount.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(bankAccountToDomain);
    },
    async create(entity: BankAccount) {
      const row = await prisma.bankAccount.create({ data: bankAccountToDb(entity) });
      return bankAccountToDomain(row);
    },
    async update(entity: BankAccount) {
      const row = await prisma.bankAccount.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: bankAccountToDb(entity),
      });
      return bankAccountToDomain(row);
    },
  };

  // Lote de importação: guarda o saldo que o BANCO declarou, para a auditoria
  // de conciliação conferir contra o saldo calculado pelo app.
  const statementImports: StatementImportRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.statementImport.findFirst({ where: { id, companyId } });
      return row ? statementImportToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.statementImport.findMany({
        where: { companyId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(statementImportToDomain);
    },
    async create(entity: StatementImport) {
      const row = await prisma.statementImport.create({ data: statementImportToDb(entity) });
      return statementImportToDomain(row);
    },
    async update(entity: StatementImport) {
      const row = await prisma.statementImport.update({
        where: { id: entity.id },
        data: statementImportToDb(entity),
      });
      return statementImportToDomain(row);
    },
    async listByAccount(companyId: ID, bankAccountId: ID) {
      const rows = await prisma.statementImport.findMany({
        where: { companyId, bankAccountId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(statementImportToDomain);
    },
    async latestWithBalanceBefore(companyId: ID, bankAccountId: ID, date: ISODate) {
      // Lotes sem saldo declarado (CSV, CNAB240, sync) não servem de referência.
      const row = await prisma.statementImport.findFirst({
        where: {
          companyId,
          bankAccountId,
          ledgerBalanceCents: { not: null },
          ledgerBalanceDate: { not: null, lte: toDbDate(date) },
        },
        // Data-base primeiro: o arquivo importado por último pode declarar um
        // saldo MAIS ANTIGO que o de um arquivo importado antes. Desempate por
        // createdAt para o caso de dois lotes com a mesma data-base.
        orderBy: [{ ledgerBalanceDate: "desc" }, { createdAt: "desc" }],
      });
      return row ? statementImportToDomain(row) : null;
    },
  };

  const bankTransactions: BankTransactionRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.bankTransaction.findFirst({ where: { id, companyId } });
      return row ? bankTransactionToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.bankTransaction.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(bankTransactionToDomain);
    },
    async create(entity: BankTransaction) {
      const row = await prisma.bankTransaction.create({ data: bankTransactionToDb(entity) });
      return bankTransactionToDomain(row);
    },
    async update(entity: BankTransaction) {
      const row = await prisma.bankTransaction.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: bankTransactionToDb(entity),
      });
      return bankTransactionToDomain(row);
    },
    async findByExternalId(companyId: ID, bankAccountId: ID, externalId: string) {
      const row = await prisma.bankTransaction.findFirst({
        where: { companyId, bankAccountId, externalId },
      });
      return row ? bankTransactionToDomain(row) : null;
    },
    async listByAccount(companyId: ID, bankAccountId: ID) {
      const rows = await prisma.bankTransaction.findMany({
        where: { companyId, bankAccountId },
        orderBy: { date: "asc" },
      });
      return rows.map(bankTransactionToDomain);
    },
    async listUnreconciled(companyId: ID) {
      const rows = await prisma.bankTransaction.findMany({
        where: { companyId, reconciled: false },
        orderBy: { date: "asc" },
      });
      return rows.map(bankTransactionToDomain);
    },
    async listByDateRange(companyId: ID, start: ISODate, end: ISODate) {
      const rows = await prisma.bankTransaction.findMany({
        where: { companyId, date: { gte: toDbDate(start), lte: toDbDate(end) } },
        orderBy: { date: "asc" },
      });
      return rows.map(bankTransactionToDomain);
    },
    async listPage(companyId, query) {
      const where = {
        companyId,
        ...(query.bankAccountId !== undefined ? { bankAccountId: query.bankAccountId } : {}),
        ...(query.reconciled !== undefined ? { reconciled: query.reconciled } : {}),
      };
      const { skip, take } = pageArgs(query);
      const [rows, total] = await Promise.all([
        prisma.bankTransaction.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          skip,
          take,
        }),
        prisma.bankTransaction.count({ where }),
      ]);
      return { items: rows.map(bankTransactionToDomain), total, offset: skip, limit: take };
    },
  };

  const payables: PayableRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.payable.findFirst({ where: { id, companyId } });
      return row ? payableToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.payable.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(payableToDomain);
    },
    async create(entity: Payable) {
      const row = await prisma.payable.create({ data: payableToDb(entity) });
      return payableToDomain(row);
    },
    async update(entity: Payable) {
      const row = await prisma.payable.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: payableToDb(entity),
      });
      return payableToDomain(row);
    },
    async findByOriginKey(companyId: ID, originKey: string) {
      const row = await prisma.payable.findUnique({
        where: { companyId_originKey: { companyId, originKey } },
      });
      return row ? payableToDomain(row) : null;
    },
    async listByStatus(companyId: ID, statuses: PayableStatus[]) {
      const rows = await prisma.payable.findMany({
        where: { companyId, status: { in: statuses } },
        orderBy: { dueDate: "asc" },
      });
      return rows.map(payableToDomain);
    },
    async listDueBetween(companyId: ID, start: ISODate, end: ISODate) {
      const rows = await prisma.payable.findMany({
        where: { companyId, dueDate: { gte: toDbDate(start), lte: toDbDate(end) } },
        orderBy: { dueDate: "asc" },
      });
      return rows.map(payableToDomain);
    },
    async listPage(companyId, query) {
      // dueDate é @db.Date — comparações usam Date (toDbDate), não ISO string.
      const where = {
        companyId,
        ...(query.statuses !== undefined ? { status: { in: query.statuses } } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.dueFrom || query.dueTo
          ? {
              dueDate: {
                ...(query.dueFrom ? { gte: toDbDate(query.dueFrom) } : {}),
                ...(query.dueTo ? { lte: toDbDate(query.dueTo) } : {}),
              },
            }
          : {}),
      };
      const { skip, take } = pageArgs(query);
      const [rows, total] = await Promise.all([
        prisma.payable.findMany({
          where,
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          skip,
          take,
        }),
        prisma.payable.count({ where }),
      ]);
      return { items: rows.map(payableToDomain), total, offset: skip, limit: take };
    },
  };

  const receivables: ReceivableRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.receivable.findFirst({ where: { id, companyId } });
      return row ? receivableToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.receivable.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(receivableToDomain);
    },
    async create(entity: Receivable) {
      const row = await prisma.receivable.create({ data: receivableToDb(entity) });
      return receivableToDomain(row);
    },
    async update(entity: Receivable) {
      const row = await prisma.receivable.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: receivableToDb(entity),
      });
      return receivableToDomain(row);
    },
    async findByOriginKey(companyId: ID, originKey: string) {
      const row = await prisma.receivable.findUnique({
        where: { companyId_originKey: { companyId, originKey } },
      });
      return row ? receivableToDomain(row) : null;
    },
    async listByStatus(companyId: ID, statuses: ReceivableStatus[]) {
      const rows = await prisma.receivable.findMany({
        where: { companyId, status: { in: statuses } },
        orderBy: { dueDate: "asc" },
      });
      return rows.map(receivableToDomain);
    },
    async listDueBetween(companyId: ID, start: ISODate, end: ISODate) {
      const rows = await prisma.receivable.findMany({
        where: { companyId, dueDate: { gte: toDbDate(start), lte: toDbDate(end) } },
        orderBy: { dueDate: "asc" },
      });
      return rows.map(receivableToDomain);
    },
    async listByCustomer(companyId: ID, customerId: ID) {
      const rows = await prisma.receivable.findMany({
        where: { companyId, customerId },
        orderBy: { dueDate: "asc" },
      });
      return rows.map(receivableToDomain);
    },
    async listPage(companyId, query) {
      // dueDate é @db.Date — comparações usam Date (toDbDate), não ISO string.
      const where = {
        companyId,
        ...(query.statuses !== undefined ? { status: { in: query.statuses } } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.dueFrom || query.dueTo
          ? {
              dueDate: {
                ...(query.dueFrom ? { gte: toDbDate(query.dueFrom) } : {}),
                ...(query.dueTo ? { lte: toDbDate(query.dueTo) } : {}),
              },
            }
          : {}),
      };
      const { skip, take } = pageArgs(query);
      const [rows, total] = await Promise.all([
        prisma.receivable.findMany({
          where,
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          skip,
          take,
        }),
        prisma.receivable.count({ where }),
      ]);
      return { items: rows.map(receivableToDomain), total, offset: skip, limit: take };
    },
  };

  const payments: PaymentRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.payment.findFirst({ where: { id, companyId } });
      return row ? paymentToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.payment.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(paymentToDomain);
    },
    async create(entity: Payment) {
      const row = await prisma.payment.create({ data: paymentToDb(entity) });
      return paymentToDomain(row);
    },
    async update(entity: Payment) {
      const row = await prisma.payment.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: paymentToDb(entity),
      });
      return paymentToDomain(row);
    },
    async listByStatus(companyId: ID, statuses: PaymentStatus[]) {
      const rows = await prisma.payment.findMany({
        where: { companyId, status: { in: statuses } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(paymentToDomain);
    },
    async listByPayable(companyId: ID, payableId: ID) {
      const rows = await prisma.payment.findMany({
        where: { companyId, payableId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(paymentToDomain);
    },
  };

  const receipts: ReceiptRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.receipt.findFirst({ where: { id, companyId } });
      return row ? receiptToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.receipt.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(receiptToDomain);
    },
    async create(entity: Receipt) {
      const row = await prisma.receipt.create({ data: receiptToDb(entity) });
      return receiptToDomain(row);
    },
    async update(entity: Receipt) {
      const row = await prisma.receipt.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: receiptToDb(entity),
      });
      return receiptToDomain(row);
    },
    async listByReceivable(companyId: ID, receivableId: ID) {
      const rows = await prisma.receipt.findMany({
        where: { companyId, receivableId },
        orderBy: { receivedDate: "asc" },
      });
      return rows.map(receiptToDomain);
    },
    async listByDateRange(companyId: ID, start: ISODate, end: ISODate) {
      const rows = await prisma.receipt.findMany({
        where: { companyId, receivedDate: { gte: toDbDate(start), lte: toDbDate(end) } },
        orderBy: { receivedDate: "asc" },
      });
      return rows.map(receiptToDomain);
    },
  };

  const documents: FinancialDocumentRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.financialDocument.findFirst({ where: { id, companyId } });
      return row ? documentToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.financialDocument.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(documentToDomain);
    },
    async create(entity: FinancialDocument) {
      const row = await prisma.financialDocument.create({ data: documentToDb(entity) });
      return documentToDomain(row);
    },
    async update(entity: FinancialDocument) {
      const row = await prisma.financialDocument.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: documentToDb(entity),
      });
      return documentToDomain(row);
    },
    async findByContentHash(companyId: ID, contentHash: string) {
      const row = await prisma.financialDocument.findUnique({
        where: { companyId_contentHash: { companyId, contentHash } },
      });
      return row ? documentToDomain(row) : null;
    },
  };

  const categories: CategoryRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.category.findFirst({ where: { id, companyId } });
      return row ? categoryToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.category.findMany({
        where: { companyId },
        orderBy: { id: "asc" },
      });
      return rows.map(categoryToDomain);
    },
    async create(entity: Category) {
      const row = await prisma.category.create({ data: categoryToDb(entity) });
      return categoryToDomain(row);
    },
    async update(entity: Category) {
      const row = await prisma.category.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: categoryToDb(entity),
      });
      return categoryToDomain(row);
    },
  };

  const costCenters: CostCenterRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.costCenter.findFirst({ where: { id, companyId } });
      return row ? costCenterToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.costCenter.findMany({
        where: { companyId },
        orderBy: { code: "asc" },
      });
      return rows.map(costCenterToDomain);
    },
    async create(entity: CostCenter) {
      const row = await prisma.costCenter.create({ data: costCenterToDb(entity) });
      return costCenterToDomain(row);
    },
    async update(entity: CostCenter) {
      const row = await prisma.costCenter.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: costCenterToDb(entity),
      });
      return costCenterToDomain(row);
    },
  };

  const chartAccounts: ChartAccountRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.chartAccount.findFirst({ where: { id, companyId } });
      return row ? chartAccountToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.chartAccount.findMany({
        where: { companyId },
        orderBy: { code: "asc" },
      });
      return rows.map(chartAccountToDomain);
    },
    async create(entity: ChartAccount) {
      const row = await prisma.chartAccount.create({ data: chartAccountToDb(entity) });
      return chartAccountToDomain(row);
    },
    async update(entity: ChartAccount) {
      const row = await prisma.chartAccount.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: chartAccountToDb(entity),
      });
      return chartAccountToDomain(row);
    },
  };

  const budgets: BudgetRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.budget.findFirst({ where: { id, companyId } });
      return row ? budgetToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.budget.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(budgetToDomain);
    },
    async create(entity: Budget) {
      const row = await prisma.budget.create({ data: budgetToDb(entity) });
      return budgetToDomain(row);
    },
    async update(entity: Budget) {
      const row = await prisma.budget.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: budgetToDb(entity),
      });
      return budgetToDomain(row);
    },
  };

  const budgetLines: BudgetLineRepo = {
    async listByBudget(budgetId: ID) {
      const rows = await prisma.budgetLine.findMany({
        where: { budgetId },
        orderBy: { period: "asc" },
      });
      return rows.map(budgetLineToDomain);
    },
    async create(entity: BudgetLine) {
      const row = await prisma.budgetLine.create({ data: budgetLineToDb(entity) });
      return budgetLineToDomain(row);
    },
    async update(entity: BudgetLine) {
      const row = await prisma.budgetLine.update({
        where: { id: entity.id },
        data: budgetLineToDb(entity),
      });
      return budgetLineToDomain(row);
    },
  };

  const approvals: ApprovalRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.approval.findFirst({ where: { id, companyId } });
      return row ? approvalToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.approval.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(approvalToDomain);
    },
    async create(entity: Approval) {
      const row = await prisma.approval.create({ data: approvalToDb(entity) });
      return approvalToDomain(row);
    },
    async update(entity: Approval) {
      const row = await prisma.approval.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: approvalToDb(entity),
      });
      return approvalToDomain(row);
    },
    async listByStatus(companyId: ID, statuses: ApprovalStatus[]) {
      const rows = await prisma.approval.findMany({
        where: { companyId, status: { in: statuses } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(approvalToDomain);
    },
    // Compare-and-set atômico no banco: o updateMany só afeta a linha se o
    // status ainda for o esperado. count===1 ⇒ esta decisão venceu a corrida.
    async updateIfStatus(next: Approval, expectedStatus: ApprovalStatus) {
      const data = approvalToDb(next);
      const result = await prisma.approval.updateMany({
        where: { id: next.id, companyId: next.companyId, status: expectedStatus },
        data,
      });
      return result.count === 1;
    },
    async updateIfVersion(next: Approval, expectedVersion: number) {
      const data = approvalToDb(next);
      const result = await prisma.approval.updateMany({
        where: { id: next.id, companyId: next.companyId, version: expectedVersion },
        data,
      });
      return result.count === 1;
    },
  };

  const reconciliations: ReconciliationRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.reconciliationMatch.findFirst({ where: { id, companyId } });
      return row ? reconciliationToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.reconciliationMatch.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(reconciliationToDomain);
    },
    async create(entity: ReconciliationMatch) {
      const row = await prisma.reconciliationMatch.create({ data: reconciliationToDb(entity) });
      return reconciliationToDomain(row);
    },
    async update(entity: ReconciliationMatch) {
      const row = await prisma.reconciliationMatch.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: reconciliationToDb(entity),
      });
      return reconciliationToDomain(row);
    },
    async listByStatus(companyId: ID, statuses: ReconciliationStatus[]) {
      const rows = await prisma.reconciliationMatch.findMany({
        where: { companyId, status: { in: statuses } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(reconciliationToDomain);
    },
    async listByBankTransaction(companyId: ID, bankTransactionId: ID) {
      const rows = await prisma.reconciliationMatch.findMany({
        where: { companyId, bankTransactionId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(reconciliationToDomain);
    },
  };

  const alerts: AlertRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.alert.findFirst({ where: { id, companyId } });
      return row ? alertToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.alert.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(alertToDomain);
    },
    async create(entity: Alert) {
      const row = await prisma.alert.create({ data: alertToDb(entity) });
      return alertToDomain(row);
    },
    async update(entity: Alert) {
      const row = await prisma.alert.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: alertToDb(entity),
      });
      return alertToDomain(row);
    },
    async listOpen(companyId: ID) {
      const rows = await prisma.alert.findMany({
        where: { companyId, status: "open" },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(alertToDomain);
    },
  };

  const events: EventRepo = {
    async append(event: EventRecordEntity) {
      await prisma.eventRecord.create({ data: eventToDb(event) });
    },
    async list(companyId: ID, type?: string) {
      const rows = await prisma.eventRecord.findMany({
        where: { companyId, ...(type ? { type } : {}) },
        orderBy: { occurredAt: "asc" },
      });
      return rows.map(eventToDomain);
    },
    async listPage(companyId, query) {
      const where = { companyId, ...(query.type ? { type: query.type } : {}) };
      const { skip, take } = pageArgs(query);
      const [rows, total] = await Promise.all([
        prisma.eventRecord.findMany({
          where,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip,
          take,
        }),
        prisma.eventRecord.count({ where }),
      ]);
      return { items: rows.map(eventToDomain), total, offset: skip, limit: take };
    },
  };

  const skillExecutions: SkillExecutionRepo = {
    async create(entity: SkillExecution) {
      const row = await prisma.skillExecution.create({ data: skillExecutionToDb(entity) });
      return skillExecutionToDomain(row);
    },
    async list(companyId: ID, skill?: string) {
      const rows = await prisma.skillExecution.findMany({
        where: { companyId, ...(skill ? { skill } : {}) },
        orderBy: { startedAt: "asc" },
      });
      return rows.map(skillExecutionToDomain);
    },
  };

  // Trilha de auditoria: append-only por contrato — este repositório
  // deliberadamente NÃO expõe update nem delete.
  const audit: AuditRepo = {
    async append(record: AuditRecord) {
      await prisma.auditRecord.create({ data: auditToDb(record) });
    },
    // Append + head numa unidade só. Fora de transação, abre uma; DENTRO de uma
    // (cliente sem $transaction, vindo de withTransaction), as duas escritas já
    // pertencem ao escopo do chamador e não se aninha nada.
    async appendWithHead(record: AuditRecord) {
      const escrever = async (client: PrismaLike) => {
        await client.auditRecord.create({ data: auditToDb(record) });
        await client.auditHead.upsert({
          where: { companyId: record.companyId },
          create: { companyId: record.companyId, seq: record.seq, hash: record.hash },
          update: { seq: record.seq, hash: record.hash },
        });
      };
      if (typeof (prisma as PrismaClient).$transaction !== "function") {
        await escrever(prisma);
        return;
      }
      await (prisma as PrismaClient).$transaction(async (tx) => escrever(tx as PrismaLike));
    },
    async last(companyId: ID) {
      const row = await prisma.auditRecord.findFirst({
        where: { companyId },
        orderBy: { seq: "desc" },
      });
      return row ? auditToDomain(row) : null;
    },
    async list(companyId: ID, filter?: { entityType?: string; entityId?: ID }) {
      const rows = await prisma.auditRecord.findMany({
        where: {
          companyId,
          ...(filter?.entityType ? { entityType: filter.entityType } : {}),
          ...(filter?.entityId ? { entityId: filter.entityId } : {}),
        },
        orderBy: { seq: "asc" },
      });
      return rows.map(auditToDomain);
    },
    async listPage(companyId, query) {
      // timestamp é DateTime; from/to vêm como "YYYY-MM-DD" (input date). O
      // intervalo cobre o DIA INTEIRO: de 00:00:00 de `from` até 23:59:59.999
      // de `to` (senão "Até" no mesmo dia excluiria tudo daquele dia).
      const where = {
        companyId,
        // Lista ⇒ `in` (nome canônico + legados; ver core/audit-actions.ts).
        ...(query.entityType
          ? {
              entityType: Array.isArray(query.entityType)
                ? { in: query.entityType }
                : query.entityType,
            }
          : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action
          ? { action: Array.isArray(query.action) ? { in: query.action } : query.action }
          : {}),
        ...(query.from || query.to
          ? {
              timestamp: {
                ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
                ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
              },
            }
          : {}),
      };
      const { skip, take } = pageArgs(query);
      const [rows, total] = await Promise.all([
        prisma.auditRecord.findMany({ where, orderBy: { seq: "desc" }, skip, take }),
        prisma.auditRecord.count({ where }),
      ]);
      return { items: rows.map(auditToDomain), total, offset: skip, limit: take };
    },
    async getHead(companyId: ID) {
      const row = await prisma.auditHead.findUnique({ where: { companyId } });
      return row ? { companyId: row.companyId, seq: row.seq, hash: row.hash } : null;
    },
    async setHead(head: AuditHead) {
      await prisma.auditHead.upsert({
        where: { companyId: head.companyId },
        create: { companyId: head.companyId, seq: head.seq, hash: head.hash },
        update: { seq: head.seq, hash: head.hash },
      });
    },
  };

  // Telemetria de atividade — sem cadeia de hash; retenção é permitida.
  const activityEvents: ActivityEventRepo = {
    async append(event: ActivityEvent) {
      await prisma.activityEvent.create({ data: activityToDb(event) });
    },
    async listPage(companyId, query) {
      // Mesma semântica de período do repositório de auditoria: from/to
      // "YYYY-MM-DD" cobrem o dia inteiro.
      const q = query.q?.trim();
      const where: Prisma.ActivityEventWhereInput = {
        companyId,
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.origin ? { origin: query.origin } : {}),
        // Tela: busca parcial (contém, sem caixa) — igual ao adaptador em memória.
        ...(query.screen ? { screen: { contains: query.screen, mode: "insensitive" as const } } : {}),
        ...(query.from || query.to
          ? {
              timestamp: {
                ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
                ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
              },
            }
          : {}),
        ...(q
          ? {
              OR: [
                { label: { contains: q, mode: "insensitive" } },
                { screen: { contains: q, mode: "insensitive" } },
                { path: { contains: q, mode: "insensitive" } },
                { elementId: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const { skip, take } = pageArgs(query);
      const [rows, total] = await Promise.all([
        prisma.activityEvent.findMany({ where, orderBy: { timestamp: "desc" }, skip, take }),
        prisma.activityEvent.count({ where }),
      ]);
      return { items: rows.map(activityToDomain), total, offset: skip, limit: take };
    },
    async listEventTypes(companyId: ID) {
      const rows = await prisma.activityEvent.findMany({
        where: { companyId },
        distinct: ["eventType"],
        select: { eventType: true },
        orderBy: { eventType: "asc" },
      });
      return rows.map((r) => r.eventType);
    },
  };

  const invoices: InvoiceRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.invoice.findFirst({ where: { id, companyId } });
      return row ? invoiceToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.invoice.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(invoiceToDomain);
    },
    async create(entity: Invoice) {
      const row = await prisma.invoice.create({ data: invoiceToDb(entity) });
      return invoiceToDomain(row);
    },
    async update(entity: Invoice) {
      const row = await prisma.invoice.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: invoiceToDb(entity),
      });
      return invoiceToDomain(row);
    },
  };

  const collectionMessages: CollectionMessageRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.collectionMessage.findFirst({ where: { id, companyId } });
      return row ? collectionMessageToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.collectionMessage.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(collectionMessageToDomain);
    },
    async create(entity: CollectionMessage) {
      const row = await prisma.collectionMessage.create({ data: collectionMessageToDb(entity) });
      return collectionMessageToDomain(row);
    },
    async update(entity: CollectionMessage) {
      const row = await prisma.collectionMessage.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: collectionMessageToDb(entity),
      });
      return collectionMessageToDomain(row);
    },
    async listByStatus(companyId: ID, statuses: CollectionMessageStatus[]) {
      const rows = await prisma.collectionMessage.findMany({
        where: { companyId, status: { in: statuses } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(collectionMessageToDomain);
    },
  };

  const accountingEntries: AccountingEntryRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.accountingEntry.findFirst({ where: { id, companyId } });
      return row ? accountingEntryToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.accountingEntry.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(accountingEntryToDomain);
    },
    async create(entity: AccountingEntry) {
      const row = await prisma.accountingEntry.create({ data: accountingEntryToDb(entity) });
      return accountingEntryToDomain(row);
    },
    async update(entity: AccountingEntry) {
      const row = await prisma.accountingEntry.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: accountingEntryToDb(entity),
      });
      return accountingEntryToDomain(row);
    },
    async listUnexported(companyId: ID) {
      const rows = await prisma.accountingEntry.findMany({
        where: { companyId, exported: false },
        orderBy: { entryDate: "asc" },
      });
      return rows.map(accountingEntryToDomain);
    },
    async listByDateRange(companyId: ID, start: ISODate, end: ISODate) {
      const rows = await prisma.accountingEntry.findMany({
        where: { companyId, entryDate: { gte: toDbDate(start), lte: toDbDate(end) } },
        orderBy: { entryDate: "asc" },
      });
      return rows.map(accountingEntryToDomain);
    },
  };

  const flowRuns: FlowRunRepo = {
    async getById(companyId: ID, id: ID) {
      const row = await prisma.flowRun.findFirst({ where: { id, companyId } });
      return row ? flowRunToDomain(row) : null;
    },
    async listAll(companyId: ID) {
      const rows = await prisma.flowRun.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(flowRunToDomain);
    },
    async create(entity: FlowRun) {
      const row = await prisma.flowRun.create({ data: flowRunToDb(entity) });
      return flowRunToDomain(row);
    },
    async update(entity: FlowRun) {
      const row = await prisma.flowRun.update({
        where: { id: entity.id, companyId: entity.companyId },
        data: flowRunToDb(entity),
      });
      return flowRunToDomain(row);
    },
    async findByApprovalId(companyId: ID, approvalId: ID) {
      const row = await prisma.flowRun.findFirst({ where: { companyId, approvalId } });
      return row ? flowRunToDomain(row) : null;
    },
  };

  const idempotency: IdempotencyRepo = {
    async findByKey(companyId: ID, key: string) {
      const row = await prisma.idempotencyRecord.findUnique({
        where: { companyId_key: { companyId, key } },
      });
      return row ? idempotencyToDomain(row) : null;
    },
    // Upsert por (companyId, key): um fluxo pode salvar na suspensão e na
    // conclusão. No update, o id original do registro é preservado.
    async save(record: IdempotencyRecord) {
      await prisma.idempotencyRecord.upsert({
        where: { companyId_key: { companyId: record.companyId, key: record.key } },
        create: idempotencyToDb(record),
        update: {
          requestHash: record.requestHash,
          resultJson: toJson(record.result),
          createdAt: toInstant(record.createdAt),
        },
      });
    },
    // Reserva atômica: INSERT que, em corrida, viola o unique (companyId, key).
    // O perdedor recebe P2002 e lê o registro vencedor.
    async reserve(record: IdempotencyRecord) {
      try {
        await prisma.idempotencyRecord.create({ data: idempotencyToDb(record) });
        return { reserved: true };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const row = await prisma.idempotencyRecord.findUnique({
            where: { companyId_key: { companyId: record.companyId, key: record.key } },
          });
          return { reserved: false, existing: row ? idempotencyToDomain(row) : undefined };
        }
        throw error;
      }
    },
    async remove(companyId: ID, key: string) {
      await prisma.idempotencyRecord
        .delete({ where: { companyId_key: { companyId, key } } })
        .catch((error) => {
          // Registro já ausente (P2025): nada a fazer.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return;
          throw error;
        });
    },
  };

  return {
    companies,
    users,
    memberships,
    customers,
    suppliers,
    supplierCategories,
    recurringTemplates,
    bankAccounts,
    bankTransactions,
    statementImports,
    payables,
    receivables,
    payments,
    receipts,
    documents,
    categories,
    costCenters,
    chartAccounts,
    budgets,
    budgetLines,
    approvals,
    reconciliations,
    alerts,
    events,
    skillExecutions,
    audit,
    activityEvents,
    invoices,
    collectionMessages,
    accountingEntries,
    flowRuns,
    idempotency,
    async withTransaction<T>(fn: (txRepos: Repositories) => Promise<T>): Promise<T> {
      // Transação real do Postgres. Se já estivermos dentro de uma transação
      // (cliente sem $transaction), reutiliza o mesmo escopo (sem aninhar).
      if (typeof (prisma as PrismaClient).$transaction !== "function") {
        return fn(createPrismaRepositories(prisma));
      }
      return (prisma as PrismaClient).$transaction((tx) =>
        fn(createPrismaRepositories(tx))
      );
    },
  };
}
