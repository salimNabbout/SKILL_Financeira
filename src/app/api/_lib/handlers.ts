/**
 * Lógica de negócio das rotas da API v1 — funções puras sobre as dependências
 * injetadas (container) e a sessão autenticada. As rotas em src/app/api/v1/**
 * são camadas finas: autenticação/HTTP lá, regras aqui (testável sem Next).
 *
 * Convenções (contratos do núcleo):
 *  - dinheiro em CENTAVOS (number inteiro); datas de negócio ISODate "YYYY-MM-DD";
 *  - IDs via deps.ids.next(prefixo); nunca new Date() (usar deps.clock);
 *  - escritas idempotentes por chave natural (repetir POST não duplica);
 *  - mutações relevantes auditadas via deps.audit.record;
 *  - nunca expor passwordHash nem dados bancários sem máscara.
 */

import { z } from "zod";
import type { AiClassifier } from "@/core/ai";
import type { AuditTrail } from "@/core/audit";
import { hasPermission, type Permission } from "@/core/auth";
import type { Clock } from "@/core/clock";
import type { CompanyConfig } from "@/core/config";
import { isISODate } from "@/core/dates";
import type {
  Actor,
  Alert,
  Approval,
  AuditRecord,
  BankAccount,
  BankTransaction,
  Category,
  Company,
  CostCenter,
  Customer,
  EventRecordEntity,
  Membership,
  Payable,
  Payment,
  Receipt,
  Receivable,
  RoleName,
  Supplier,
  User,
} from "@/core/entities";
import { DomainError, NotFoundError, PermissionError, ValidationError } from "@/core/errors";
import type { Page } from "@/core/repositories";
import type { Integrations } from "@/core/integrations";
import type { EventBus } from "@/core/events";
import type { IdGenerator } from "@/core/ids";
import type {
  Orchestrator,
  OrchestratorResponse,
} from "@/core/orchestrator/orchestrator";
import type { SkillRegistry } from "@/core/orchestrator/registry";
import type { Repositories } from "@/core/repositories";
import { todayInTz } from "@/core/dates";
import { runSkill, type SkillContext } from "@/core/skill";
import type { SkillResult } from "@/core/types";
import { verifyPassword } from "@/lib/password";
import { maskSensitive, publicCompany, publicUser, type PublicCompany, type PublicUser } from "./respond";

// ---------------------------------------------------------------------------
// Dependências e sessão (estruturalmente compatíveis com AppContainer/SessionInfo)
// ---------------------------------------------------------------------------

export interface ApiDeps {
  repos: Repositories;
  events: EventBus;
  audit: AuditTrail;
  clock: Clock;
  ids: IdGenerator;
  ai: AiClassifier;
  integrations: Integrations;
  registry: SkillRegistry;
  orchestrator: Orchestrator;
}

export interface ApiSession {
  user: User;
  membership: Membership;
  company: Company;
  config: CompanyConfig;
  actor: Actor;
}

function requirePermission(session: ApiSession, permission: Permission): void {
  if (!hasPermission(session.membership.role, permission)) {
    throw new PermissionError(
      `Papel ${session.membership.role} não possui a permissão ${permission}.`
    );
  }
}

// Genérico sobre o schema (não sobre o tipo) para respeitar campos com .default().
function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Entrada inválida: ${detail}`);
  }
  return parsed.data;
}

const isoDateSchema = z
  .string()
  .refine(isISODate, { message: "data inválida (esperado YYYY-MM-DD)" });

const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "período inválido (esperado YYYY-MM)");

/** Normaliza documento/código para comparação de chave natural. */
function normKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().trim().min(1, "informe o e-mail"),
  password: z.string().min(1, "informe a senha"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface LoginResult {
  user: PublicUser;
  companyId: string;
}

export async function login(deps: ApiDeps, rawInput: unknown): Promise<LoginResult> {
  const input = parse(loginSchema, rawInput);
  const user = await deps.repos.users.findByEmail(input.email);
  // Mensagem única para credencial errada — não revela se o e-mail existe.
  const invalid = new DomainError("invalid_credentials", "E-mail ou senha inválidos.");
  if (!user || !user.active || !verifyPassword(input.password, user.passwordHash)) {
    throw invalid;
  }
  const memberships = await deps.repos.memberships.listByUser(user.id);
  if (memberships.length === 0) {
    throw new DomainError("invalid_credentials", "Usuário sem empresa vinculada.");
  }
  const companyId = memberships[0].companyId;
  await deps.audit.record(companyId, {
    actor: { type: "user", id: user.id },
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
  });
  return { user: publicUser(user), companyId };
}

// ---------------------------------------------------------------------------
// Sessão atual, empresas e usuários
// ---------------------------------------------------------------------------

export interface MeResult {
  user: PublicUser;
  company: PublicCompany;
  role: RoleName;
  approvalLimitCents: number | null;
}

export function getMe(session: ApiSession): MeResult {
  return {
    user: publicUser(session.user),
    company: publicCompany(session.company),
    role: session.membership.role,
    approvalLimitCents: session.membership.approvalLimitCents,
  };
}

export async function listCompanies(
  deps: ApiDeps,
  session: ApiSession
): Promise<Array<PublicCompany & { role: RoleName; current: boolean }>> {
  const memberships = await deps.repos.memberships.listByUser(session.user.id);
  const out: Array<PublicCompany & { role: RoleName; current: boolean }> = [];
  for (const m of memberships) {
    const company = await deps.repos.companies.getById(m.companyId);
    if (!company) continue;
    out.push({ ...publicCompany(company), role: m.role, current: m.companyId === session.company.id });
  }
  return out;
}

export interface CompanyUser extends PublicUser {
  role: RoleName;
  approvalLimitCents: number | null;
}

export async function listCompanyUsers(deps: ApiDeps, session: ApiSession): Promise<CompanyUser[]> {
  const memberships = await deps.repos.memberships.listByCompany(session.company.id);
  const out: CompanyUser[] = [];
  for (const m of memberships) {
    const user = await deps.repos.users.getById(m.userId);
    if (!user) continue;
    // publicUser remove o passwordHash — nunca devolvê-lo (LGPD).
    out.push({ ...publicUser(user), role: m.role, approvalLimitCents: m.approvalLimitCents });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cadastros (CRUD leve, POST idempotente por chave natural)
// ---------------------------------------------------------------------------

export interface CreateOutcome<T> {
  entity: T;
  /** false = registro já existia (replay idempotente); nada foi criado. */
  created: boolean;
}

async function auditCreation(
  deps: ApiDeps,
  session: ApiSession,
  entityType: string,
  entityId: string,
  after: unknown
): Promise<void> {
  await deps.audit.record(session.company.id, {
    actor: session.actor,
    action: `${entityType.toLowerCase()}.created`,
    entityType,
    entityId,
    after,
  });
}

// --- Fornecedores ---

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, "informe o nome"),
  document: z.string().trim().min(1).optional(),
  email: z.string().trim().email("e-mail inválido").optional(),
  phone: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
  /** Dados bancários crus: são mascarados ANTES de persistir (nunca guardados em claro). */
  bankInfo: z.string().trim().min(1).optional(),
  pixKey: z.string().trim().min(1).optional(),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export async function listSuppliers(deps: ApiDeps, session: ApiSession): Promise<Supplier[]> {
  return deps.repos.suppliers.listAll(session.company.id);
}

export async function createSupplier(
  deps: ApiDeps,
  session: ApiSession,
  rawInput: unknown
): Promise<CreateOutcome<Supplier>> {
  requirePermission(session, "master_data.manage");
  const input = parse(createSupplierSchema, rawInput);

  const all = await deps.repos.suppliers.listAll(session.company.id);
  const existing = all.find((s) =>
    input.document && s.document
      ? normKey(s.document) === normKey(input.document)
      : normKey(s.name) === normKey(input.name)
  );
  if (existing) return { entity: existing, created: false };

  const now = deps.clock.now().toISOString();
  const supplier: Supplier = {
    id: deps.ids.next("sup"),
    companyId: session.company.id,
    name: input.name,
    document: input.document,
    email: input.email,
    phone: input.phone,
    address: input.address,
    bankInfoMasked: input.bankInfo ? maskSensitive(input.bankInfo) : undefined,
    pixKeyMasked: input.pixKey ? maskSensitive(input.pixKey) : undefined,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const created = await deps.repos.suppliers.create(supplier);
  await auditCreation(deps, session, "Supplier", created.id, {
    name: created.name,
    document: created.document,
    // Apenas as versões mascaradas entram na trilha — nunca o dado bancário cru.
    bankInfoMasked: created.bankInfoMasked,
    pixKeyMasked: created.pixKeyMasked,
  });
  return { entity: created, created: true };
}

// --- Clientes ---

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, "informe o nome"),
  document: z.string().trim().min(1).optional(),
  email: z.string().trim().email("e-mail inválido").optional(),
  phone: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export async function listCustomers(deps: ApiDeps, session: ApiSession): Promise<Customer[]> {
  return deps.repos.customers.listAll(session.company.id);
}

export async function createCustomer(
  deps: ApiDeps,
  session: ApiSession,
  rawInput: unknown
): Promise<CreateOutcome<Customer>> {
  requirePermission(session, "master_data.manage");
  const input = parse(createCustomerSchema, rawInput);

  const all = await deps.repos.customers.listAll(session.company.id);
  const existing = all.find((c) =>
    input.document && c.document
      ? normKey(c.document) === normKey(input.document)
      : normKey(c.name) === normKey(input.name)
  );
  if (existing) return { entity: existing, created: false };

  const now = deps.clock.now().toISOString();
  const customer: Customer = {
    id: deps.ids.next("cus"),
    companyId: session.company.id,
    ...input,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const created = await deps.repos.customers.create(customer);
  await auditCreation(deps, session, "Customer", created.id, {
    name: created.name,
    document: created.document,
  });
  return { entity: created, created: true };
}

// --- Categorias ---

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "informe o nome"),
  kind: z.enum(["income", "expense"]),
  dreGroup: z.enum([
    "receita_bruta",
    "deducoes",
    "custos",
    "despesas_operacionais",
    "despesas_financeiras",
    "receitas_financeiras",
    "outras",
  ]),
  parentId: z.string().min(1).optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export async function listCategories(deps: ApiDeps, session: ApiSession): Promise<Category[]> {
  return deps.repos.categories.listAll(session.company.id);
}

export async function createCategory(
  deps: ApiDeps,
  session: ApiSession,
  rawInput: unknown
): Promise<CreateOutcome<Category>> {
  requirePermission(session, "master_data.manage");
  const input = parse(createCategorySchema, rawInput);

  const all = await deps.repos.categories.listAll(session.company.id);
  const existing = all.find(
    (c) => c.kind === input.kind && normKey(c.name) === normKey(input.name)
  );
  if (existing) return { entity: existing, created: false };

  const category: Category = {
    id: deps.ids.next("cat"),
    companyId: session.company.id,
    name: input.name,
    kind: input.kind,
    dreGroup: input.dreGroup,
    parentId: input.parentId,
    active: true,
  };
  const created = await deps.repos.categories.create(category);
  await auditCreation(deps, session, "Category", created.id, {
    name: created.name,
    kind: created.kind,
    dreGroup: created.dreGroup,
  });
  return { entity: created, created: true };
}

// --- Centros de custo ---

export const createCostCenterSchema = z.object({
  code: z.string().trim().min(1, "informe o código"),
  name: z.string().trim().min(1, "informe o nome"),
});
export type CreateCostCenterInput = z.infer<typeof createCostCenterSchema>;

export async function listCostCenters(deps: ApiDeps, session: ApiSession): Promise<CostCenter[]> {
  return deps.repos.costCenters.listAll(session.company.id);
}

export async function createCostCenter(
  deps: ApiDeps,
  session: ApiSession,
  rawInput: unknown
): Promise<CreateOutcome<CostCenter>> {
  requirePermission(session, "master_data.manage");
  const input = parse(createCostCenterSchema, rawInput);

  const all = await deps.repos.costCenters.listAll(session.company.id);
  const existing = all.find((c) => normKey(c.code) === normKey(input.code));
  if (existing) return { entity: existing, created: false };

  const costCenter: CostCenter = {
    id: deps.ids.next("cc"),
    companyId: session.company.id,
    code: input.code,
    name: input.name,
    active: true,
  };
  const created = await deps.repos.costCenters.create(costCenter);
  await auditCreation(deps, session, "CostCenter", created.id, {
    code: created.code,
    name: created.name,
  });
  return { entity: created, created: true };
}

// --- Contas bancárias ---

export const createBankAccountSchema = z.object({
  name: z.string().trim().min(1, "informe o nome"),
  bankCode: z.string().trim().min(1, "informe o código do banco"),
  agency: z.string().trim().min(1, "informe a agência"),
  /** Número cru da conta: mascarado ANTES de persistir (só os 4 últimos ficam visíveis). */
  accountNumber: z.string().trim().min(1, "informe o número da conta"),
  type: z.enum(["checking", "savings", "payment"]),
  currency: z.enum(["BRL", "USD", "EUR"]).default("BRL"),
  openingBalanceCents: z.number().int("valor em centavos inteiros"),
  openingBalanceDate: isoDateSchema,
});
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;

export async function listBankAccounts(deps: ApiDeps, session: ApiSession): Promise<BankAccount[]> {
  return deps.repos.bankAccounts.listAll(session.company.id);
}

export async function createBankAccount(
  deps: ApiDeps,
  session: ApiSession,
  rawInput: unknown
): Promise<CreateOutcome<BankAccount>> {
  requirePermission(session, "bank_account.manage");
  const input = parse(createBankAccountSchema, rawInput);
  const accountNumberMasked = maskSensitive(input.accountNumber);

  const all = await deps.repos.bankAccounts.listAll(session.company.id);
  const existing = all.find(
    (a) =>
      normKey(a.bankCode) === normKey(input.bankCode) &&
      normKey(a.agency) === normKey(input.agency) &&
      a.accountNumberMasked === accountNumberMasked
  );
  if (existing) return { entity: existing, created: false };

  const now = deps.clock.now().toISOString();
  const account: BankAccount = {
    id: deps.ids.next("acc"),
    companyId: session.company.id,
    name: input.name,
    bankCode: input.bankCode,
    agency: input.agency,
    accountNumberMasked,
    type: input.type,
    currency: input.currency,
    openingBalanceCents: input.openingBalanceCents,
    openingBalanceDate: input.openingBalanceDate,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const created = await deps.repos.bankAccounts.create(account);
  await auditCreation(deps, session, "BankAccount", created.id, {
    name: created.name,
    bankCode: created.bankCode,
    agency: created.agency,
    accountNumberMasked: created.accountNumberMasked,
  });
  return { entity: created, created: true };
}

// ---------------------------------------------------------------------------
// Títulos (somente leitura na API; escrita passa pelos fluxos do orquestrador)
// ---------------------------------------------------------------------------

/** Paginação padrão das listagens: ?limit= (1..200, default 50) e ?offset=. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Página calculada em memória (usada nos caminhos com filtros de data legados). */
function pageOf<T>(sorted: T[], q: { offset: number; limit: number }): Page<T> {
  return {
    items: sorted.slice(q.offset, q.offset + q.limit),
    total: sorted.length,
    offset: q.offset,
    limit: q.limit,
  };
}

export const listPayablesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["open", "scheduled", "partially_paid", "paid", "canceled"]).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListPayablesQuery = z.infer<typeof listPayablesQuerySchema>;

export async function listPayables(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Page<Payable>> {
  const query = parse(listPayablesQuerySchema, rawQuery);
  // from/to não fazem parte do finder paginado do repositório: com eles, o
  // filtro roda em memória (total correto); sem eles, a paginação é do banco.
  if (query.from || query.to) {
    const all = await deps.repos.payables.listAll(session.company.id);
    const filtered = all
      .filter((p) => (query.status ? p.status === query.status : true))
      .filter((p) => (query.from ? p.dueDate >= query.from : true))
      .filter((p) => (query.to ? p.dueDate <= query.to : true))
      .sort((a, b) =>
        a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1
      );
    return pageOf(filtered, query);
  }
  return deps.repos.payables.listPage(session.company.id, {
    offset: query.offset,
    limit: query.limit,
    statuses: query.status ? [query.status] : undefined,
  });
}

export interface PayableDetail {
  payable: Payable;
  payments: Payment[];
}

export async function getPayable(
  deps: ApiDeps,
  session: ApiSession,
  id: string
): Promise<PayableDetail> {
  const payable = await deps.repos.payables.getById(session.company.id, id);
  if (!payable) throw new NotFoundError("Título a pagar", id);
  const payments = await deps.repos.payments.listByPayable(session.company.id, id);
  return { payable, payments };
}

export const listReceivablesQuerySchema = pageQuerySchema.extend({
  status: z.enum(["open", "partially_received", "received", "canceled"]).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListReceivablesQuery = z.infer<typeof listReceivablesQuerySchema>;

export async function listReceivables(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Page<Receivable>> {
  const query = parse(listReceivablesQuerySchema, rawQuery);
  if (query.from || query.to) {
    const all = await deps.repos.receivables.listAll(session.company.id);
    const filtered = all
      .filter((r) => (query.status ? r.status === query.status : true))
      .filter((r) => (query.from ? r.dueDate >= query.from : true))
      .filter((r) => (query.to ? r.dueDate <= query.to : true))
      .sort((a, b) =>
        a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1
      );
    return pageOf(filtered, query);
  }
  return deps.repos.receivables.listPage(session.company.id, {
    offset: query.offset,
    limit: query.limit,
    statuses: query.status ? [query.status] : undefined,
  });
}

export interface ReceivableDetail {
  receivable: Receivable;
  receipts: Receipt[];
}

export async function getReceivable(
  deps: ApiDeps,
  session: ApiSession,
  id: string
): Promise<ReceivableDetail> {
  const receivable = await deps.repos.receivables.getById(session.company.id, id);
  if (!receivable) throw new NotFoundError("Título a receber", id);
  const receipts = await deps.repos.receipts.listByReceivable(session.company.id, id);
  return { receivable, receipts };
}

export const issueChargeSchema = z.object({
  kind: z.enum(["pix", "boleto"]),
});
export type IssueChargeApiInput = z.infer<typeof issueChargeSchema>;

/**
 * Gera código de cobrança (Pix/boleto) para o saldo em aberto do título via a
 * porta ChargeProvider. No MVP o provedor é MOCK: código fake, nada registrado
 * em PSP/banco. Idempotente: reemitir não duplica a anotação no título.
 */
export async function issueReceivableCharge(
  deps: ApiDeps,
  session: ApiSession,
  receivableId: string,
  rawInput: unknown
): Promise<SkillResult<unknown>> {
  requirePermission(session, "receivable.create");
  const input = parse(issueChargeSchema, rawInput);
  const ctx: SkillContext = {
    companyId: session.company.id,
    actor: session.actor,
    repos: deps.repos,
    events: deps.events,
    audit: deps.audit,
    clock: deps.clock,
    ids: deps.ids,
    config: session.config,
    ai: deps.ai,
    integrations: deps.integrations,
    correlationId: deps.ids.next("corr"),
    today: () => todayInTz(deps.clock.now(), session.config.timezone),
  };
  return runSkill(deps.registry.get("contas_a_receber"), ctx, {
    action: "issue_charge",
    receivableId,
    kind: input.kind,
  });
}

export const listBankTransactionsQuerySchema = pageQuerySchema.extend({
  accountId: z.string().min(1).optional(),
  reconciled: z.enum(["true", "false"]).optional(),
});
export type ListBankTransactionsQuery = z.infer<typeof listBankTransactionsQuerySchema>;

export async function listBankTransactions(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Page<BankTransaction>> {
  const query = parse(listBankTransactionsQuerySchema, rawQuery);
  return deps.repos.bankTransactions.listPage(session.company.id, {
    offset: query.offset,
    limit: query.limit,
    bankAccountId: query.accountId,
    reconciled: query.reconciled === undefined ? undefined : query.reconciled === "true",
  });
}

// ---------------------------------------------------------------------------
// Aprovações
// ---------------------------------------------------------------------------

export const listApprovalsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
});

export async function listApprovals(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Approval[]> {
  const query = parse(listApprovalsQuerySchema, rawQuery);
  const all = query.status
    ? await deps.repos.approvals.listByStatus(session.company.id, [query.status])
    : await deps.repos.approvals.listAll(session.company.id);
  return all.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
}

export const decideApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  justification: z.string().trim().min(1).optional(),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

/**
 * Decide uma aprovação pendente. Alçada, segregação de funções e retomada do
 * fluxo suspenso são responsabilidade do orquestrador (regras determinísticas).
 */
export async function decideApproval(
  deps: ApiDeps,
  session: ApiSession,
  approvalId: string,
  rawInput: unknown
): Promise<OrchestratorResponse | { approval: Approval }> {
  const input = parse(decideApprovalSchema, rawInput);
  return deps.orchestrator.decideApproval({
    companyId: session.company.id,
    approvalId,
    decision: input.decision,
    actor: session.actor,
    justification: input.justification,
  });
}

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------

export const listAlertsQuerySchema = z.object({
  status: z.enum(["open", "acknowledged", "resolved"]).optional(),
});

export async function listAlerts(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Alert[]> {
  const query = parse(listAlertsQuerySchema, rawQuery);
  const all = await deps.repos.alerts.listAll(session.company.id);
  return all
    .filter((a) => (query.status ? a.status === query.status : true))
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
}

/** Marca um alerta como ciente (acknowledged). Idempotente: repetir não altera nada. */
export async function acknowledgeAlert(
  deps: ApiDeps,
  session: ApiSession,
  id: string
): Promise<CreateOutcome<Alert>> {
  const alert = await deps.repos.alerts.getById(session.company.id, id);
  if (!alert) throw new NotFoundError("Alerta", id);
  if (alert.status !== "open") return { entity: alert, created: false };

  const updated = await deps.repos.alerts.update({ ...alert, status: "acknowledged" });
  await deps.audit.record(session.company.id, {
    actor: session.actor,
    action: "alert.acknowledged",
    entityType: "Alert",
    entityId: alert.id,
    before: { status: alert.status },
    after: { status: updated.status },
  });
  return { entity: updated, created: true };
}

// ---------------------------------------------------------------------------
// Orquestrador: fluxos
// ---------------------------------------------------------------------------

export interface FlowSummary {
  name: string;
  description: string;
  requiredPermission: Permission;
  steps: Array<{ id: string; skill: string; description: string }>;
}

export function listFlows(deps: ApiDeps): FlowSummary[] {
  return deps.orchestrator.listFlows().map((f) => ({
    name: f.name,
    description: f.description,
    requiredPermission: f.requiredPermission,
    steps: f.steps.map((s) => ({ id: s.id, skill: s.skill, description: s.description })),
  }));
}

export const executeFlowSchema = z.object({
  payload: z.unknown().optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});
export type ExecuteFlowInput = z.infer<typeof executeFlowSchema>;

export async function executeFlow(
  deps: ApiDeps,
  session: ApiSession,
  flow: string,
  rawInput: unknown
): Promise<OrchestratorResponse> {
  const input = parse(executeFlowSchema, rawInput);
  return deps.orchestrator.execute({
    flow,
    companyId: session.company.id,
    actor: session.actor,
    payload: input.payload ?? {},
    idempotencyKey: input.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Auditoria, skills e eventos
// ---------------------------------------------------------------------------

export const auditQuerySchema = pageQuerySchema.extend({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
});

export async function getAuditTrail(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Page<AuditRecord>> {
  requirePermission(session, "audit.view");
  const query = parse(auditQuerySchema, rawQuery);
  return deps.repos.audit.listPage(session.company.id, {
    offset: query.offset,
    limit: query.limit,
    entityType: query.entityType,
    entityId: query.entityId,
  });
}

export interface SkillSummary {
  name: string;
  responsibility: string;
  objective: string;
  consumes: string[];
  publishes: string[];
  dataSources: string[];
}

export function listSkills(deps: ApiDeps): SkillSummary[] {
  return deps.registry.list().map((s) => ({
    name: s.name,
    responsibility: s.responsibility,
    objective: s.objective,
    consumes: [...s.consumes],
    publishes: [...s.publishes],
    dataSources: [...s.dataSources],
  }));
}

export const eventsQuerySchema = pageQuerySchema.extend({
  type: z.string().min(1).optional(),
});

export async function listEvents(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: unknown
): Promise<Page<EventRecordEntity>> {
  const query = parse(eventsQuerySchema, rawQuery);
  return deps.repos.events.listPage(session.company.id, {
    offset: query.offset,
    limit: query.limit,
    type: query.type,
  });
}

// ---------------------------------------------------------------------------
// Importação de extrato (atalho para o fluxo bank_statement_import)
// ---------------------------------------------------------------------------

/**
 * Apenas JSON com o conteúdo do arquivo como string (multipart NÃO é aceito no
 * MVP — o cliente lê o arquivo e envia o texto em `content`).
 */
export const importStatementSchema = z.object({
  bankAccountId: z.string().min(1, "informe a conta bancária"),
  format: z.enum(["ofx", "csv", "cnab240"]),
  content: z.string().min(1, "conteúdo do extrato vazio"),
});
export type ImportStatementInput = z.infer<typeof importStatementSchema>;

export async function importStatement(
  deps: ApiDeps,
  session: ApiSession,
  rawInput: unknown
): Promise<OrchestratorResponse> {
  const input = parse(importStatementSchema, rawInput);
  return deps.orchestrator.execute({
    flow: "bank_statement_import",
    companyId: session.company.id,
    actor: session.actor,
    payload: input,
  });
}

export { periodSchema, isoDateSchema };
