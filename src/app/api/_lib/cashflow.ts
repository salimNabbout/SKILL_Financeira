/**
 * API v1 — disciplina Fluxo de Caixa (`/api/v1/fluxo-caixa/*`).
 *
 * Handlers puros (sem Next): recebem `ApiDeps` + `ApiSession`, validam com
 * zod, aplicam permissão e devolvem objetos serializáveis. Dinheiro sempre em
 * INTEIRO de centavos (`*Cents`); nunca float.
 *
 * Leitura: `report.view` (quem vê relatórios vê o fluxo). Escrita nas tabelas
 * `fc_*` (parâmetros, cenários, de-para, ajustes manuais): `budget.manage`.
 * Toda escrita é transacional, auditada com antes/depois e protegida por
 * trava otimista (`version`): gravar com versão defasada → 409.
 *
 * O módulo NUNCA escreve nos módulos existentes: as fontes (títulos,
 * pagamentos, recebimentos, extrato, conciliação) entram só por leitura, na
 * unificação de domínio (`unifyCashflow`), e o cálculo é recomputado a cada
 * chamada — não há cache silencioso; `atualizadoEm` é o instante do cálculo.
 */

import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "@/core/audit-actions";
import { hasPermission, type Permission } from "@/core/auth";
import { todayInTz } from "@/core/dates";
import type {
  CashflowCategory,
  CashflowEntry,
  CashflowManualEntry,
  CashflowMapping,
  CashflowMappingSource,
  CashflowParameter,
  CashflowScenario,
  CashflowScenarioCode,
} from "@/core/entities";
import { ConflictError, NotFoundError, PermissionError, ValidationError } from "@/core/errors";
import {
  CASHFLOW_SCENARIO_SEED,
  CASHFLOW_TRANSFER_ID,
  CASHFLOW_UNCLASSIFIED_ID,
  computeCashflow,
  normalizeKey,
  unifyCashflow,
  type CashflowAlert,
  type CashflowComputeOutput,
  type UnifyExclusion,
} from "@/core/cashflow";
import type { ApiDeps, ApiSession } from "./handlers";

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function requirePermission(session: ApiSession, permission: Permission): void {
  if (!hasPermission(session.membership.role, permission)) {
    throw new PermissionError(`Papel ${session.membership.role} não possui a permissão ${permission}.`);
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; ");
    throw new ValidationError(`Entrada inválida: ${detail}`);
  }
  return parsed.data;
}

const yearSchema = z.coerce.number().int().min(2000).max(2100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data no formato YYYY-MM-DD");
const centsSchema = z.number().int("inteiro de centavos");
const scenarioCodeSchema = z.enum(["otimista", "realista", "pessimista"]);
const mappingSourceSchema = z.enum(["plano_contas", "categoria_ap", "categoria_ar", "regra_texto"]);

function currentYear(deps: ApiDeps, session: ApiSession): number {
  return Number(todayInTz(deps.clock.now(), session.config.timezone).slice(0, 4));
}

function yearOf(deps: ApiDeps, session: ApiSession, raw: Record<string, string>): number {
  return raw.ano ? parse(yearSchema, raw.ano) : currentYear(deps, session);
}

/** Trava otimista: versão informada tem de ser a atual. */
function assertVersion(current: number, provided: number | undefined, what: string): void {
  if (provided !== undefined && provided !== current) {
    throw new ConflictError(
      `${what} foi alterado por outro usuário (versão atual ${current}, enviada ${provided}). Recarregue e tente de novo.`
    );
  }
}

// ---------------------------------------------------------------------------
// Contexto: fontes + unificação + parâmetros (leitura)
// ---------------------------------------------------------------------------

export interface ParameterView {
  year: number;
  openingBalanceCents: number;
  minimumReserveCents: number;
  realizedMonthsOverride?: number;
  version: number;
  /** false = ainda não gravado: valores padrão (saldo 0; reserva = caixa mínimo da empresa). */
  configured: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ScenarioView {
  code: CashflowScenarioCode;
  name: string;
  revenueAdjustmentBp: number;
  expenseAdjustmentBp: number;
  monthlyGrowthBp: number;
  active: boolean;
  version: number;
  configured: boolean;
}

export interface CashflowContext {
  year: number;
  computedAt: string;
  entries: CashflowEntry[];
  excluded: UnifyExclusion[];
  categories: CashflowCategory[];
  parameter: ParameterView;
  parameterEntity?: CashflowParameter;
  scenarios: ScenarioView[];
  scenarioEntities: CashflowScenario[];
}

function defaultScenarios(companyId: string, now: string): CashflowScenario[] {
  return CASHFLOW_SCENARIO_SEED.map((s) => ({
    id: `fcs_${companyId}_${s.code}`,
    companyId,
    code: s.code,
    name: s.name,
    revenueAdjustmentBp: s.revenueAdjustmentBp,
    expenseAdjustmentBp: s.expenseAdjustmentBp,
    monthlyGrowthBp: s.monthlyGrowthBp,
    active: true,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    version: 0,
  }));
}

async function loadParameter(deps: ApiDeps, session: ApiSession, year: number) {
  const entity = await deps.repos.cashflowParameters.findByYear(session.company.id, year);
  const view: ParameterView = entity
    ? {
        year,
        openingBalanceCents: entity.openingBalanceCents,
        minimumReserveCents: entity.minimumReserveCents,
        realizedMonthsOverride: entity.realizedMonthsOverride,
        version: entity.version,
        configured: true,
        updatedAt: entity.updatedAt,
        updatedBy: entity.updatedBy ?? entity.createdBy,
      }
    : {
        year,
        openingBalanceCents: 0,
        minimumReserveCents: session.config.minimumCashCents,
        version: 0,
        configured: false,
      };
  return { entity: entity ?? undefined, view };
}

async function loadScenarios(deps: ApiDeps, session: ApiSession) {
  const stored = await deps.repos.cashflowScenarios.listAll(session.company.id);
  const now = deps.clock.now().toISOString();
  const defaults = defaultScenarios(session.company.id, now);
  // Cenário ausente no banco → padrão da planilha (não persistido até ser editado).
  const entities = defaults.map((d) => stored.find((s) => s.code === d.code) ?? d);
  const views: ScenarioView[] = entities.map((s) => ({
    code: s.code,
    name: s.name,
    revenueAdjustmentBp: s.revenueAdjustmentBp,
    expenseAdjustmentBp: s.expenseAdjustmentBp,
    monthlyGrowthBp: s.monthlyGrowthBp,
    active: s.active,
    version: s.version,
    configured: stored.some((x) => x.code === s.code),
  }));
  return { entities, views };
}

export async function loadCashflowContext(deps: ApiDeps, session: ApiSession, year: number): Promise<CashflowContext> {
  requirePermission(session, "report.view");
  const companyId = session.company.id;
  const [payables, payments, receivables, receipts, bankAccounts, bankTransactions, matches, manualEntries, mappings, categories] =
    await Promise.all([
      deps.repos.payables.listAll(companyId),
      deps.repos.payments.listAll(companyId),
      deps.repos.receivables.listAll(companyId),
      deps.repos.receipts.listAll(companyId),
      deps.repos.bankAccounts.listAll(companyId),
      deps.repos.bankTransactions.listAll(companyId),
      deps.repos.reconciliations.listAll(companyId),
      deps.repos.cashflowManualEntries.listAll(companyId),
      deps.repos.cashflowMappings.listAll(companyId),
      deps.repos.cashflowCategories.listAll(),
    ]);
  const unified = unifyCashflow({
    timeZone: session.config.timezone,
    payables,
    payments,
    receivables,
    receipts,
    bankAccounts,
    bankTransactions,
    matches,
    manualEntries,
    mappings,
    categories,
  });
  const param = await loadParameter(deps, session, year);
  const scen = await loadScenarios(deps, session);
  return {
    year,
    computedAt: deps.clock.now().toISOString(),
    entries: unified.entries,
    excluded: unified.excluded,
    categories,
    parameter: param.view,
    parameterEntity: param.entity,
    scenarios: scen.views,
    scenarioEntities: scen.entities,
  };
}

function compute(ctx: CashflowContext): CashflowComputeOutput {
  return computeCashflow({
    year: ctx.year,
    entries: ctx.entries,
    categories: ctx.categories,
    parameter: {
      openingBalanceCents: ctx.parameter.openingBalanceCents,
      minimumReserveCents: ctx.parameter.minimumReserveCents,
      realizedMonthsOverride: ctx.parameter.realizedMonthsOverride,
    },
    scenarios: ctx.scenarioEntities,
  });
}

// ---------------------------------------------------------------------------
// Parâmetros e cenários
// ---------------------------------------------------------------------------

export async function getCashflowParameters(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>) {
  requirePermission(session, "report.view");
  const year = yearOf(deps, session, rawQuery);
  const param = await loadParameter(deps, session, year);
  const scen = await loadScenarios(deps, session);
  return { parameter: param.view, scenarios: scen.views };
}

export const putParametersSchema = z.object({
  year: yearSchema,
  openingBalanceCents: centsSchema,
  minimumReserveCents: centsSchema.min(0, "reserva não pode ser negativa"),
  realizedMonthsOverride: z.number().int().min(0).max(12).nullable().optional(),
  version: z.number().int().min(0).optional(),
  scenarios: z
    .array(
      z.object({
        code: scenarioCodeSchema,
        revenueAdjustmentBp: z.number().int().min(-10_000).max(100_000),
        expenseAdjustmentBp: z.number().int().min(-10_000).max(100_000),
        monthlyGrowthBp: z.number().int().min(-10_000).max(100_000),
        active: z.boolean().optional(),
        version: z.number().int().min(0).optional(),
      })
    )
    .optional(),
});

export async function putCashflowParameters(deps: ApiDeps, session: ApiSession, rawBody: unknown) {
  requirePermission(session, "budget.manage");
  const body = parse(putParametersSchema, rawBody);
  const now = deps.clock.now().toISOString();
  const companyId = session.company.id;

  await deps.repos.withTransaction(async (tx) => {
    const audit = deps.audit.withTx(tx);
    const existing = await tx.cashflowParameters.findByYear(companyId, body.year);
    assertVersion(existing?.version ?? 0, body.version, `Parâmetros de ${body.year}`);
    const next: CashflowParameter = existing
      ? {
          ...existing,
          openingBalanceCents: body.openingBalanceCents,
          minimumReserveCents: body.minimumReserveCents,
          realizedMonthsOverride: body.realizedMonthsOverride ?? undefined,
          updatedBy: session.user.id,
          updatedAt: now,
          version: existing.version + 1,
        }
      : {
          id: deps.ids.next("fcp"),
          companyId,
          baseYear: body.year,
          openingBalanceCents: body.openingBalanceCents,
          minimumReserveCents: body.minimumReserveCents,
          realizedMonthsOverride: body.realizedMonthsOverride ?? undefined,
          createdBy: session.user.id,
          createdAt: now,
          updatedBy: undefined,
          updatedAt: now,
          version: 1,
        };
    if (existing) await tx.cashflowParameters.update(next);
    else await tx.cashflowParameters.create(next);
    await audit.record(companyId, {
      actor: session.actor,
      action: AUDIT_ACTIONS.CASHFLOW_PARAMETER_UPDATED,
      entityType: AUDIT_ENTITIES.CASHFLOW_PARAMETER,
      entityId: next.id,
      before: existing ?? undefined,
      after: next,
    });

    for (const s of body.scenarios ?? []) {
      const stored = await tx.cashflowScenarios.findByCode(companyId, s.code);
      assertVersion(stored?.version ?? 0, s.version, `Cenário ${s.code}`);
      const seed = defaultScenarios(companyId, now).find((d) => d.code === s.code)!;
      const nextScenario: CashflowScenario = stored
        ? { ...stored, ...s, active: s.active ?? stored.active, updatedBy: session.user.id, updatedAt: now, version: stored.version + 1 }
        : { ...seed, ...s, active: s.active ?? true, createdBy: session.user.id, createdAt: now, updatedAt: now, version: 1 };
      if (stored) await tx.cashflowScenarios.update(nextScenario);
      else await tx.cashflowScenarios.create(nextScenario);
      await audit.record(companyId, {
        actor: session.actor,
        action: AUDIT_ACTIONS.CASHFLOW_SCENARIO_UPDATED,
        entityType: AUDIT_ENTITIES.CASHFLOW_SCENARIO,
        entityId: nextScenario.id,
        before: stored ?? undefined,
        after: nextScenario,
      });
    }
  });

  return getCashflowParameters(deps, session, { ano: String(body.year) });
}

// ---------------------------------------------------------------------------
// Categorias e de-para
// ---------------------------------------------------------------------------

export async function listCashflowCategories(deps: ApiDeps, session: ApiSession): Promise<CashflowCategory[]> {
  requirePermission(session, "report.view");
  return deps.repos.cashflowCategories.listAll();
}

export async function listCashflowMappings(deps: ApiDeps, session: ApiSession): Promise<CashflowMapping[]> {
  requirePermission(session, "report.view");
  return deps.repos.cashflowMappings.listAll(session.company.id);
}

export const putMappingSchema = z.object({
  source: mappingSourceSchema,
  sourceKey: z.string().trim().min(1, "informe a chave de origem"),
  categoryId: z.string().trim().min(1, "informe a categoria"),
  priority: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
  version: z.number().int().min(0).optional(),
});

/** Cria ou atualiza o de-para de UMA chave (única por origem + chave normalizada). */
export async function putCashflowMapping(deps: ApiDeps, session: ApiSession, rawBody: unknown) {
  requirePermission(session, "budget.manage");
  const body = parse(putMappingSchema, rawBody);
  const category = await deps.repos.cashflowCategories.getById(body.categoryId);
  if (!category) throw new NotFoundError("Categoria do fluxo de caixa", body.categoryId);
  if (!category.active && body.categoryId !== CASHFLOW_TRANSFER_ID) {
    throw new ValidationError(`Categoria "${category.name}" está inativa.`);
  }
  const companyId = session.company.id;
  const now = deps.clock.now().toISOString();
  const key = normalizeKey(body.sourceKey);

  return deps.repos.withTransaction(async (tx) => {
    const audit = deps.audit.withTx(tx);
    const all = await tx.cashflowMappings.listAll(companyId);
    const existing = all.find((m) => m.source === body.source && normalizeKey(m.sourceKey) === key);
    assertVersion(existing?.version ?? 0, body.version, `De-para ${body.source}:${body.sourceKey}`);
    const next: CashflowMapping = existing
      ? {
          ...existing,
          categoryId: body.categoryId,
          priority: body.priority ?? existing.priority,
          active: body.active ?? existing.active,
          updatedBy: session.user.id,
          updatedAt: now,
          version: existing.version + 1,
        }
      : {
          id: deps.ids.next("fcm"),
          companyId,
          source: body.source,
          sourceKey: body.sourceKey.trim(),
          categoryId: body.categoryId,
          priority: body.priority ?? 100,
          active: body.active ?? true,
          createdBy: session.user.id,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
    if (existing) await tx.cashflowMappings.update(next);
    else await tx.cashflowMappings.create(next);
    await audit.record(companyId, {
      actor: session.actor,
      action: AUDIT_ACTIONS.CASHFLOW_MAPPING_UPSERTED,
      entityType: AUDIT_ENTITIES.CASHFLOW_MAPPING,
      entityId: next.id,
      before: existing,
      after: next,
    });
    return { entity: next, created: !existing };
  });
}

// ---------------------------------------------------------------------------
// Lançamentos unificados
// ---------------------------------------------------------------------------

export const entriesQuerySchema = z.object({
  ano: yearSchema.optional(),
  mes: z.coerce.number().int().min(1).max(12).optional(),
  categoria: z.string().trim().min(1).optional(),
  status: z.enum(["previsto", "realizado"]).optional(),
  centro_custo: z.string().trim().min(1).optional(),
  origem: z.enum(["conciliacao", "contas_pagar", "contas_receber", "ajuste_manual"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export interface EntriesPage {
  year: number;
  items: CashflowEntry[];
  total: number;
  offset: number;
  limit: number;
  /** Totais do CONJUNTO filtrado (não só da página). */
  totals: { entradasCents: number; saidasCents: number; liquidoCents: number };
  computedAt: string;
}

export async function listCashflowEntries(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>): Promise<EntriesPage> {
  const q = parse(entriesQuerySchema, rawQuery);
  const year = q.ano ?? currentYear(deps, session);
  const ctx = await loadCashflowContext(deps, session, year);
  const filtered = ctx.entries.filter(
    (e) =>
      e.year === year &&
      (q.mes === undefined || e.month === q.mes) &&
      (q.categoria === undefined || e.categoryId === q.categoria) &&
      (q.status === undefined || e.status === q.status) &&
      (q.centro_custo === undefined || e.costCenterId === q.centro_custo) &&
      (q.origem === undefined || e.origin === q.origem)
  );
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 50;
  const entradasCents = filtered.filter((e) => e.kind === "entrada").reduce((a, e) => a + e.amountCents, 0);
  const saidasCents = filtered.filter((e) => e.kind === "saida").reduce((a, e) => a + e.amountCents, 0);
  return {
    year,
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
    totals: { entradasCents, saidasCents, liquidoCents: entradasCents - saidasCents },
    computedAt: ctx.computedAt,
  };
}

// ---------------------------------------------------------------------------
// Ajustes manuais
// ---------------------------------------------------------------------------

export const manualEntrySchema = z.object({
  competenceDate: isoDate,
  kind: z.enum(["entrada", "saida"]),
  categoryId: z.string().trim().min(1),
  description: z.string().trim().min(1, "informe a descrição").max(300),
  costCenterId: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["previsto", "realizado"]),
  amountCents: centsSchema.positive("valor deve ser positivo; o sinal vem do tipo"),
  sourceNote: z.string().trim().max(300).nullable().optional(),
});
export const manualEntryUpdateSchema = manualEntrySchema.extend({ version: z.number().int().min(0).optional() });

async function assertManualEntryRefs(deps: ApiDeps, session: ApiSession, body: z.infer<typeof manualEntrySchema>) {
  const category = await deps.repos.cashflowCategories.getById(body.categoryId);
  if (!category) throw new NotFoundError("Categoria do fluxo de caixa", body.categoryId);
  if (category.kind === "neutro") throw new ValidationError("Ajuste manual não pode usar a categoria neutra de transferência.");
  if (category.kind !== body.kind) {
    throw new ValidationError(`Categoria "${category.name}" é de ${category.kind}; o lançamento é de ${body.kind}.`);
  }
  if (body.costCenterId) {
    const cc = await deps.repos.costCenters.getById(session.company.id, body.costCenterId);
    if (!cc) throw new NotFoundError("Centro de custo", body.costCenterId);
  }
}

export async function createCashflowManualEntry(deps: ApiDeps, session: ApiSession, rawBody: unknown): Promise<CashflowManualEntry> {
  requirePermission(session, "budget.manage");
  const body = parse(manualEntrySchema, rawBody);
  await assertManualEntryRefs(deps, session, body);
  const now = deps.clock.now().toISOString();
  const entity: CashflowManualEntry = {
    id: deps.ids.next("fca"),
    companyId: session.company.id,
    competenceDate: body.competenceDate,
    kind: body.kind,
    categoryId: body.categoryId,
    description: body.description,
    costCenterId: body.costCenterId ?? undefined,
    status: body.status,
    amountCents: body.amountCents,
    sourceNote: body.sourceNote ?? undefined,
    createdBy: session.user.id,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  return deps.repos.withTransaction(async (tx) => {
    const created = await tx.cashflowManualEntries.create(entity);
    await deps.audit.withTx(tx).record(session.company.id, {
      actor: session.actor,
      action: AUDIT_ACTIONS.CASHFLOW_MANUAL_ENTRY_CREATED,
      entityType: AUDIT_ENTITIES.CASHFLOW_MANUAL_ENTRY,
      entityId: created.id,
      after: created,
    });
    return created;
  });
}

export async function updateCashflowManualEntry(deps: ApiDeps, session: ApiSession, id: string, rawBody: unknown): Promise<CashflowManualEntry> {
  requirePermission(session, "budget.manage");
  const body = parse(manualEntryUpdateSchema, rawBody);
  await assertManualEntryRefs(deps, session, body);
  const now = deps.clock.now().toISOString();
  return deps.repos.withTransaction(async (tx) => {
    const existing = await tx.cashflowManualEntries.getById(session.company.id, id);
    if (!existing) throw new NotFoundError("Ajuste manual", id);
    assertVersion(existing.version, body.version, "Ajuste manual");
    const next: CashflowManualEntry = {
      ...existing,
      competenceDate: body.competenceDate,
      kind: body.kind,
      categoryId: body.categoryId,
      description: body.description,
      costCenterId: body.costCenterId ?? undefined,
      status: body.status,
      amountCents: body.amountCents,
      sourceNote: body.sourceNote ?? undefined,
      updatedBy: session.user.id,
      updatedAt: now,
      version: existing.version + 1,
    };
    const updated = await tx.cashflowManualEntries.update(next);
    await deps.audit.withTx(tx).record(session.company.id, {
      actor: session.actor,
      action: AUDIT_ACTIONS.CASHFLOW_MANUAL_ENTRY_UPDATED,
      entityType: AUDIT_ENTITIES.CASHFLOW_MANUAL_ENTRY,
      entityId: id,
      before: existing,
      after: updated,
    });
    return updated;
  });
}

export async function deleteCashflowManualEntry(deps: ApiDeps, session: ApiSession, id: string): Promise<{ id: string; deleted: true }> {
  requirePermission(session, "budget.manage");
  return deps.repos.withTransaction(async (tx) => {
    const existing = await tx.cashflowManualEntries.getById(session.company.id, id);
    if (!existing) throw new NotFoundError("Ajuste manual", id);
    await tx.cashflowManualEntries.delete(session.company.id, id);
    await deps.audit.withTx(tx).record(session.company.id, {
      actor: session.actor,
      action: AUDIT_ACTIONS.CASHFLOW_MANUAL_ENTRY_DELETED,
      entityType: AUDIT_ENTITIES.CASHFLOW_MANUAL_ENTRY,
      entityId: id,
      before: existing,
    });
    return { id, deleted: true as const };
  });
}

// ---------------------------------------------------------------------------
// Grades: mensal, previsto x realizado, projeção, dashboard
// ---------------------------------------------------------------------------

function meta(ctx: CashflowContext, out: CashflowComputeOutput) {
  return {
    year: ctx.year,
    computedAt: ctx.computedAt,
    parameterConfigured: ctx.parameter.configured,
    naoClassificados: { count: out.monthly.naoClassificadosCount, totalCents: out.monthly.naoClassificadosCents },
  };
}

export async function getCashflowMonthly(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>) {
  const ctx = await loadCashflowContext(deps, session, yearOf(deps, session, rawQuery));
  const out = compute(ctx);
  return { ...meta(ctx, out), monthly: out.monthly };
}

export async function getCashflowVariance(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>) {
  const ctx = await loadCashflowContext(deps, session, yearOf(deps, session, rawQuery));
  const out = compute(ctx);
  return { ...meta(ctx, out), variance: out.variance };
}

export async function getCashflowProjection(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>) {
  const q = parse(z.object({ ano: yearSchema.optional(), cenario: scenarioCodeSchema.optional() }), rawQuery);
  const ctx = await loadCashflowContext(deps, session, q.ano ?? currentYear(deps, session));
  const out = compute(ctx);
  const projection = q.cenario
    ? { ...out.projection, scenarios: out.projection.scenarios.filter((s) => s.code === q.cenario) }
    : out.projection;
  if (q.cenario && projection.scenarios.length === 0) throw new NotFoundError("Cenário", q.cenario);
  return { ...meta(ctx, out), projection };
}

export interface DashboardView {
  year: number;
  computedAt: string;
  parameterConfigured: boolean;
  kpis: {
    entradasAnoCents: number;
    saidasAnoCents: number;
    resultadoAnoCents: number;
    saldoFinalAnoCents: number;
    saldo12MesesCents: Partial<Record<CashflowScenarioCode, number>>;
    mesesRisco: Partial<Record<CashflowScenarioCode, { abaixoReserva: number; negativos: number }>>;
    realizedMonths: number;
    lowConfidence: boolean;
  };
  series: {
    /** 12 meses do ano base: entradas, saídas e saldo final (Fluxo Mensal). */
    mensal: Array<{ month: string; entradasCents: number; saidasCents: number; saldoCents: number; situacao: string }>;
    /** Composição das saídas do ano por grupo. */
    composicao: Array<{ group: string; label: string; totalCents: number }>;
    /** Saldo projetado mês a mês, por cenário. */
    cenarios: Array<{ code: CashflowScenarioCode; name: string; months: Array<{ month: string; balanceCents: number }> }>;
  };
  alerts: CashflowAlert[];
  warnings: string[];
  naoClassificados: { count: number; totalCents: number };
}

export async function getCashflowDashboard(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>): Promise<DashboardView> {
  const ctx = await loadCashflowContext(deps, session, yearOf(deps, session, rawQuery));
  const out = compute(ctx);
  const { monthly, projection, alerts } = out;
  const saldo12: DashboardView["kpis"]["saldo12MesesCents"] = {};
  const risco: DashboardView["kpis"]["mesesRisco"] = {};
  for (const s of projection.scenarios) {
    saldo12[s.code] = s.balance12Cents;
    risco[s.code] = { abaixoReserva: s.monthsBelowReserve, negativos: s.monthsNegative };
  }
  return {
    year: ctx.year,
    computedAt: ctx.computedAt,
    parameterConfigured: ctx.parameter.configured,
    kpis: {
      entradasAnoCents: monthly.entradasAnoCents,
      saidasAnoCents: monthly.saidasAnoCents,
      resultadoAnoCents: monthly.resultadoAnoCents,
      saldoFinalAnoCents: monthly.saldoFinal[11],
      saldo12MesesCents: saldo12,
      mesesRisco: risco,
      realizedMonths: projection.realizedMonths,
      lowConfidence: projection.lowConfidence,
    },
    series: {
      mensal: monthly.entradasTotal.map((v, i) => ({
        month: `${ctx.year}-${String(i + 1).padStart(2, "0")}`,
        entradasCents: v,
        saidasCents: monthly.saidasTotal[i],
        saldoCents: monthly.saldoFinal[i],
        situacao: monthly.situacao[i],
      })),
      composicao: monthly.saidasGrupos.map((g) => ({ group: g.group, label: g.label, totalCents: g.totalCents })),
      cenarios: projection.scenarios.map((s) => ({
        code: s.code,
        name: s.name,
        months: s.months.map((m) => ({ month: m.month, balanceCents: m.balanceCents })),
      })),
    },
    alerts,
    warnings: [
      ...(ctx.parameter.configured ? [] : ["Parâmetros do exercício não configurados: saldo inicial 0 e reserva mínima = caixa mínimo da empresa."]),
      ...projection.warnings,
    ],
    naoClassificados: { count: monthly.naoClassificadosCount, totalCents: monthly.naoClassificadosCents },
  };
}

// ---------------------------------------------------------------------------
// Pendências (a_classificar) e recálculo
// ---------------------------------------------------------------------------

export interface PendingGroup {
  /** Chave sugerida para o de-para (a de maior precedência disponível no lançamento). */
  source: CashflowMappingSource;
  sourceKey: string;
  count: number;
  totalCents: number;
  kinds: Array<"entrada" | "saida">;
  samples: string[];
  originIds: string[];
}

export async function getCashflowPending(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>) {
  const ctx = await loadCashflowContext(deps, session, yearOf(deps, session, rawQuery));
  const pending = ctx.entries.filter((e) => e.year === ctx.year && e.categoryId === CASHFLOW_UNCLASSIFIED_ID);
  const groups = new Map<string, PendingGroup>();
  for (const e of pending) {
    const candidate = e.mappingKeys?.[0] ?? { source: "regra_texto" as const, sourceKey: e.description };
    const key = `${candidate.source}:${normalizeKey(candidate.sourceKey)}`;
    const g = groups.get(key) ?? {
      source: candidate.source,
      sourceKey: candidate.sourceKey,
      count: 0,
      totalCents: 0,
      kinds: [],
      samples: [],
      originIds: [],
    };
    g.count += 1;
    g.totalCents += e.amountCents;
    if (!g.kinds.includes(e.kind)) g.kinds.push(e.kind);
    if (g.samples.length < 3 && !g.samples.includes(e.description)) g.samples.push(e.description);
    g.originIds.push(e.originId);
    groups.set(key, g);
  }
  const items = [...groups.values()].sort((a, b) => b.totalCents - a.totalCents || a.sourceKey.localeCompare(b.sourceKey));
  return {
    year: ctx.year,
    computedAt: ctx.computedAt,
    total: pending.length,
    totalCents: pending.reduce((a, e) => a + e.amountCents, 0),
    groups: items,
    entries: pending,
  };
}

/**
 * "Recalcular": não há view materializada — a unificação é recomputada a cada
 * chamada. Este endpoint recomputa e devolve o carimbo e as contagens, para a
 * UI exibir "atualizado em" e para provar idempotência (duas chamadas, mesmo
 * resultado).
 */
export async function recalculateCashflow(deps: ApiDeps, session: ApiSession, rawQuery: Record<string, string>) {
  const ctx = await loadCashflowContext(deps, session, yearOf(deps, session, rawQuery));
  const out = compute(ctx);
  const byReason: Record<string, number> = {};
  for (const x of ctx.excluded) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
  return {
    year: ctx.year,
    atualizadoEm: ctx.computedAt,
    lancamentos: ctx.entries.filter((e) => e.year === ctx.year).length,
    lancamentosTotal: ctx.entries.length,
    excluidos: byReason,
    naoClassificados: out.monthly.naoClassificadosCount,
    resultadoAnoCents: out.monthly.resultadoAnoCents,
  };
}
