/**
 * API v1 — Fluxo de Caixa: handlers puros sobre o adaptador em memória.
 * Cobre permissões, trava otimista (409), auditoria com antes/depois, a
 * unificação sobre fontes reais do app e as grades com o dataset da planilha.
 */
import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { ConflictError, NotFoundError, PermissionError, ValidationError } from "@/core/errors";
import { buildRegistry } from "@/skills";
import type { ApiDeps, ApiSession } from "../_lib/handlers";
import {
  createCashflowManualEntry,
  deleteCashflowManualEntry,
  getCashflowDashboard,
  getCashflowMonthly,
  getCashflowParameters,
  getCashflowPending,
  getCashflowProjection,
  getCashflowVariance,
  listCashflowCategories,
  listCashflowEntries,
  listCashflowMappings,
  putCashflowMapping,
  putCashflowParameters,
  recalculateCashflow,
  updateCashflowManualEntry,
} from "../_lib/cashflow";

function buildDeps(env: TestEnv): ApiDeps {
  const registry = buildRegistry();
  return {
    repos: env.repos,
    events: env.events,
    audit: env.audit,
    clock: env.clock,
    ids: env.ids,
    ai: env.ai,
    integrations: env.integrations,
    registry,
    orchestrator: env.orchestrator(registry),
  };
}

async function sessionFor(env: TestEnv, key: "admin" | "manager" | "analyst" | "viewer"): Promise<ApiSession> {
  const user = env.users[key];
  const membership = await env.repos.memberships.findByUserAndCompany(user.id, env.company.id);
  if (!membership) throw new Error(`membership ausente para ${key}`);
  return { user, membership, company: env.company, config: env.config, actor: { type: "user", id: user.id, role: membership.role } };
}

const R = (reais: number) => Math.round(reais * 100);
const YEAR = 2026; // relógio fixo do createTestEnv: 2026-08-18

async function seedSources(env: TestEnv) {
  const now = env.clock.now().toISOString();
  const co = env.company.id;
  await env.repos.suppliers.create({ id: "sup_1", companyId: co, name: "Light", document: "1", active: true, createdAt: now, updatedAt: now });
  await env.repos.customers.create({ id: "cus_1", companyId: co, name: "Cliente", document: "2", active: true, createdAt: now, updatedAt: now });
  await env.repos.bankAccounts.create({ id: "ba_1", companyId: co, name: "Itaú", bankCode: "341", agency: "1", accountNumberMasked: "****", type: "checking", currency: "BRL", openingBalanceCents: 0, openingBalanceDate: "2026-01-01", active: true, createdAt: now, updatedAt: now });
  await env.repos.categories.create({ id: "cat_serv", companyId: co, name: "Serviços", kind: "income", dreGroup: "receita_bruta", active: true });
  // Pago no app, com pagamento executado, sem extrato → realizado por baixa_app (decisão A).
  await env.repos.payables.create({ id: "pv_pago", companyId: co, supplierId: "sup_1", description: "Energia sala 1227", issueDate: "2026-07-01", dueDate: "2026-07-20", amountCents: R(1_500), paidCents: R(1_500), currency: "BRL", status: "paid", installmentNumber: 1, installmentCount: 1, originKey: "k1", supplierCategory: "Concessionaria - Energia", createdBy: "u", createdAt: now, updatedAt: now });
  await env.repos.payments.create({ id: "pay_1", companyId: co, payableId: "pv_pago", bankAccountId: "ba_1", amountCents: R(1_500), scheduledDate: "2026-07-20", executedAt: "2026-07-20T12:00:00.000Z", status: "executed", requestedBy: "u", createdAt: now, updatedAt: now });
  // Em aberto → previsto no vencimento.
  await env.repos.payables.create({ id: "pv_aberto", companyId: co, supplierId: "sup_1", description: "Energia sala 1235", issueDate: "2026-08-01", dueDate: "2026-09-10", amountCents: R(900), paidCents: 0, currency: "BRL", status: "open", installmentNumber: 1, installmentCount: 1, originKey: "k2", supplierCategory: "Concessionaria - Energia", createdBy: "u", createdAt: now, updatedAt: now });
  // Recebido, com recibo.
  await env.repos.receivables.create({ id: "rv_1", companyId: co, customerId: "cus_1", description: "Mensalidade", issueDate: "2026-08-01", dueDate: "2026-08-10", amountCents: R(4_000), receivedCents: R(4_000), currency: "BRL", status: "received", categoryId: "cat_serv", installmentNumber: 1, installmentCount: 1, originKey: "k3", createdBy: "u", createdAt: now, updatedAt: now });
  await env.repos.receipts.create({ id: "rc_1", companyId: co, receivableId: "rv_1", bankAccountId: "ba_1", amountCents: R(4_000), receivedDate: "2026-08-12", method: "pix", status: "registered", registeredBy: "u", createdAt: now });
  // Extrato mock: fora.
  await env.repos.bankTransactions.create({ id: "tx_mock", companyId: co, bankAccountId: "ba_1", date: "2026-08-15", amountCents: -R(10), currency: "BRL", description: "MOCK", source: "api_mock", reconciled: false, createdAt: now });
}

describe("API Fluxo de Caixa — parâmetros e cenários", () => {
  it("GET sem gravação devolve padrões (configured=false, reserva = caixa mínimo da empresa) e os 3 cenários da planilha", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const out = await getCashflowParameters(deps, await sessionFor(env, "viewer"), {});
    expect(out.parameter).toMatchObject({ year: YEAR, openingBalanceCents: 0, minimumReserveCents: env.config.minimumCashCents, configured: false, version: 0 });
    expect(out.scenarios.map((s) => [s.code, s.revenueAdjustmentBp, s.expenseAdjustmentBp, s.configured])).toEqual([
      ["otimista", 1500, 0, false],
      ["realista", 0, 0, false],
      ["pessimista", -2000, 500, false],
    ]);
  });

  it("PUT grava com auditoria (antes/depois), incrementa a versão e recusa versão defasada com 409", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");

    const first = await putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: R(85_000), minimumReserveCents: R(60_000), realizedMonthsOverride: 3 });
    expect(first.parameter).toMatchObject({ configured: true, version: 1, openingBalanceCents: R(85_000), realizedMonthsOverride: 3 });
    const audit = env.db.auditRecords.filter((a) => a.action === "cashflow.parameter_updated");
    expect(audit).toHaveLength(1);
    expect(audit[0].before).toBeUndefined();
    expect((audit[0].after as { openingBalanceCents: number }).openingBalanceCents).toBe(R(85_000));

    const second = await putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: R(90_000), minimumReserveCents: R(60_000), realizedMonthsOverride: null, version: 1 });
    expect(second.parameter.version).toBe(2);
    expect(second.parameter.realizedMonthsOverride).toBeUndefined();

    await expect(
      putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: 1, minimumReserveCents: 0, version: 1 })
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await getCashflowParameters(deps, manager, { ano: String(YEAR) })).parameter.openingBalanceCents).toBe(R(90_000));
  });

  it("PUT com cenários persiste as premissas em pontos-base e audita cada cenário", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");
    const out = await putCashflowParameters(deps, manager, {
      year: YEAR, openingBalanceCents: 0, minimumReserveCents: 0,
      scenarios: [{ code: "pessimista", revenueAdjustmentBp: -3000, expenseAdjustmentBp: 1000, monthlyGrowthBp: 0 }],
    });
    const pess = out.scenarios.find((s) => s.code === "pessimista")!;
    expect(pess).toMatchObject({ revenueAdjustmentBp: -3000, expenseAdjustmentBp: 1000, configured: true, version: 1 });
    expect(out.scenarios.find((s) => s.code === "otimista")?.configured).toBe(false);
    expect(env.db.auditRecords.some((a) => a.action === "cashflow.scenario_updated")).toBe(true);
  });

  it("viewer lê, mas não grava (permission_denied); valores inválidos são recusados", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const viewer = await sessionFor(env, "viewer");
    await expect(putCashflowParameters(deps, viewer, { year: YEAR, openingBalanceCents: 0, minimumReserveCents: 0 })).rejects.toBeInstanceOf(PermissionError);
    const manager = await sessionFor(env, "manager");
    await expect(putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: 10.5, minimumReserveCents: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: 0, minimumReserveCents: -1 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("API Fluxo de Caixa — categorias, de-para e pendências", () => {
  it("lista o plano e faz upsert do de-para por (origem, chave normalizada)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");
    expect(await listCashflowCategories(deps, manager)).toHaveLength(38);

    const created = await putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "Concessionaria - Energia", categoryId: "energia_eletrica" });
    expect(created.created).toBe(true);
    expect(created.entity).toMatchObject({ priority: 100, active: true, version: 1 });
    const updated = await putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "concessionária - energia", categoryId: "energia_eletrica", priority: 5, version: 1 });
    expect(updated.created).toBe(false);
    expect(updated.entity).toMatchObject({ id: created.entity.id, priority: 5, version: 2 });
    expect(await listCashflowMappings(deps, manager)).toHaveLength(1);
    await expect(putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "x", categoryId: "nao_existe" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "Concessionaria - Energia", categoryId: "aluguel", version: 1 })).rejects.toBeInstanceOf(ConflictError);
    expect(env.db.auditRecords.filter((a) => a.action === "cashflow.mapping_upserted")).toHaveLength(2);
  });

  it("pendências agrupam a_classificar pela chave sugerida; classificar em um clique esvazia a fila", async () => {
    const env = createTestEnv();
    await seedSources(env);
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");

    const before = await getCashflowPending(deps, manager, { ano: String(YEAR) });
    expect(before.total).toBe(3); // pv_pago (realizado), pv_aberto (previsto), rv_1 (recebido)
    const energia = before.groups.find((g) => g.source === "categoria_ap")!;
    expect(energia).toMatchObject({ sourceKey: "Concessionaria - Energia", count: 2, totalCents: R(2_400) });
    const receber = before.groups.find((g) => g.source === "categoria_ar")!;
    expect(receber.sourceKey).toBe("cat_serv");

    await putCashflowMapping(deps, manager, { source: energia.source, sourceKey: energia.sourceKey, categoryId: "energia_eletrica" });
    await putCashflowMapping(deps, manager, { source: receber.source, sourceKey: receber.sourceKey, categoryId: "prestacao_servicos" });
    const after = await getCashflowPending(deps, manager, { ano: String(YEAR) });
    expect(after.total).toBe(0);
    const entries = await listCashflowEntries(deps, manager, { ano: String(YEAR) });
    expect(entries.items.map((e) => e.categoryId).sort()).toEqual(["energia_eletrica", "energia_eletrica", "prestacao_servicos"]);
  });
});

describe("API Fluxo de Caixa — lançamentos unificados", () => {
  it("lista com filtros, paginação e totais do conjunto; extrato mock fica fora", async () => {
    const env = createTestEnv();
    await seedSources(env);
    const deps = buildDeps(env);
    const viewer = await sessionFor(env, "viewer");

    const all = await listCashflowEntries(deps, viewer, { ano: String(YEAR) });
    expect(all.total).toBe(3);
    expect(all.totals).toEqual({ entradasCents: R(4_000), saidasCents: R(2_400), liquidoCents: R(1_600) });
    expect(all.items.every((e) => e.origin !== "conciliacao")).toBe(true);

    const realizados = await listCashflowEntries(deps, viewer, { ano: String(YEAR), status: "realizado" });
    expect(realizados.items.map((e) => e.originId).sort()).toEqual(["pay_1", "rc_1"]);
    expect(realizados.items.every((e) => e.realizedBy === "baixa_app")).toBe(true);

    const setembro = await listCashflowEntries(deps, viewer, { ano: String(YEAR), mes: "9" });
    expect(setembro.items.map((e) => e.originId)).toEqual(["pv_aberto"]);
    expect(setembro.items[0]).toMatchObject({ status: "previsto", cashDate: "2026-09-10", competenceDate: "2026-08-01" });

    const page = await listCashflowEntries(deps, viewer, { ano: String(YEAR), offset: "1", limit: "1" });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.totals.liquidoCents).toBe(R(1_600));

    await expect(listCashflowEntries(deps, viewer, { ano: "abc" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("API Fluxo de Caixa — ajustes manuais", () => {
  it("cria, altera (409 se defasado) e exclui com auditoria antes/depois; valida categoria, tipo e valor", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");

    const created = await createCashflowManualEntry(deps, manager, { competenceDate: "2026-10-05", kind: "entrada", categoryId: "outras_receitas", description: "Aporte de sócio", status: "previsto", amountCents: R(50_000) });
    expect(created).toMatchObject({ version: 1, createdBy: env.users.manager.id });

    await expect(createCashflowManualEntry(deps, manager, { competenceDate: "2026-10-05", kind: "entrada", categoryId: "aluguel", description: "x", status: "previsto", amountCents: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCashflowManualEntry(deps, manager, { competenceDate: "2026-10-05", kind: "saida", categoryId: "aluguel", description: "x", status: "previsto", amountCents: -5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCashflowManualEntry(deps, manager, { competenceDate: "2026-10-05", kind: "saida", categoryId: "transferencia_interna", description: "x", status: "previsto", amountCents: 5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCashflowManualEntry(deps, await sessionFor(env, "viewer"), { competenceDate: "2026-10-05", kind: "saida", categoryId: "aluguel", description: "x", status: "previsto", amountCents: 5 })).rejects.toBeInstanceOf(PermissionError);

    const updated = await updateCashflowManualEntry(deps, manager, created.id, { competenceDate: "2026-10-05", kind: "entrada", categoryId: "outras_receitas", description: "Aporte de sócio (confirmado)", status: "realizado", amountCents: R(50_000), version: 1 });
    expect(updated).toMatchObject({ status: "realizado", version: 2 });
    await expect(updateCashflowManualEntry(deps, manager, created.id, { ...updated, version: 1 })).rejects.toBeInstanceOf(ConflictError);

    const entries = await listCashflowEntries(deps, manager, { ano: String(YEAR), origem: "ajuste_manual" });
    expect(entries.items[0]).toMatchObject({ originId: created.id, status: "realizado", categoryId: "outras_receitas", month: 10 });

    await deleteCashflowManualEntry(deps, manager, created.id);
    await expect(deleteCashflowManualEntry(deps, manager, created.id)).rejects.toBeInstanceOf(NotFoundError);
    const acoes = env.db.auditRecords.filter((a) => a.entityType === "cashflow_manual_entry").map((a) => a.action);
    expect(acoes).toEqual(["cashflow.manual_entry_created", "cashflow.manual_entry_updated", "cashflow.manual_entry_deleted"]);
    const del = env.db.auditRecords.find((a) => a.action === "cashflow.manual_entry_deleted")!;
    expect((del.before as { id: string }).id).toBe(created.id);
  });
});

describe("API Fluxo de Caixa — grades, projeção, dashboard e recálculo", () => {
  async function seedPlanilha(env: TestEnv, deps: ApiDeps, manager: ApiSession) {
    await putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: R(85_000), minimumReserveCents: R(60_000), realizedMonthsOverride: 3 });
    const rows: Array<[string, string, string, number, "previsto" | "realizado"]> = [
      ["2026-07-15", "entrada", "prestacao_servicos", 92_000, "realizado"],
      ["2026-07-15", "saida", "folha_salarios", 48_000, "realizado"],
      ["2026-07-15", "saida", "simples_nacional_das", 9_400, "realizado"],
      ["2026-08-15", "entrada", "prestacao_servicos", 76_000, "realizado"],
      ["2026-08-15", "saida", "folha_salarios", 48_000, "realizado"],
      ["2026-08-15", "saida", "fornecedores", 31_000, "realizado"],
      ["2026-08-15", "saida", "software_assinaturas", 4_200, "realizado"],
      ["2026-09-15", "entrada", "vendas_produtos", 58_000, "realizado"],
      ["2026-09-15", "saida", "folha_salarios", 49_500, "realizado"],
      ["2026-09-15", "saida", "aluguel", 12_800, "realizado"],
      ["2026-10-15", "entrada", "prestacao_servicos", 110_000, "previsto"],
      ["2026-10-15", "saida", "materiais_equipamentos", 44_000, "previsto"],
    ];
    for (const [competenceDate, kind, categoryId, reais, status] of rows) {
      await createCashflowManualEntry(deps, manager, { competenceDate, kind, categoryId, description: categoryId, status, amountCents: R(reais) });
    }
  }

  it("mensal, previsto x realizado e projeção reproduzem a planilha ao centavo; ?cenario= filtra", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");
    await seedPlanilha(env, deps, manager);

    const mensal = await getCashflowMonthly(deps, manager, { ano: String(YEAR) });
    expect(mensal.parameterConfigured).toBe(true);
    expect(mensal.monthly.saldoFinal.slice(6, 10)).toEqual([R(119_600), R(112_400), R(108_100), R(174_100)]);
    expect(mensal.monthly.resultadoAnoCents).toBe(R(89_100));

    const pr = await getCashflowVariance(deps, manager, { ano: String(YEAR) });
    expect(pr.variance.lines.find((l) => l.key === "entradas")!.previsto[9]).toBe(R(110_000));

    const proj = await getCashflowProjection(deps, manager, { ano: String(YEAR) });
    expect(proj.projection.scenarios.map((s) => s.balance12Cents)).toEqual([R(336_100), R(200_500), R(-20_880)]);
    const only = await getCashflowProjection(deps, manager, { ano: String(YEAR), cenario: "pessimista" });
    expect(only.projection.scenarios.map((s) => s.code)).toEqual(["pessimista"]);
    expect(only.projection.scenarios[0].monthsBelowReserve).toBe(8);
  });

  it("dashboard traz KPIs, séries e alertas com valores; sem parâmetros gravados avisa", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");
    const vazio = await getCashflowDashboard(deps, await sessionFor(env, "viewer"), {});
    expect(vazio.parameterConfigured).toBe(false);
    expect(vazio.warnings.some((w) => /não configurados/.test(w))).toBe(true);
    expect(vazio.series.mensal).toHaveLength(12);

    await seedPlanilha(env, deps, manager);
    const dash = await getCashflowDashboard(deps, manager, { ano: String(YEAR) });
    expect(dash.kpis).toMatchObject({ entradasAnoCents: R(336_000), saidasAnoCents: R(246_900), resultadoAnoCents: R(89_100), saldoFinalAnoCents: R(174_100), realizedMonths: 3, lowConfidence: false });
    expect(dash.kpis.saldo12MesesCents).toEqual({ otimista: R(336_100), realista: R(200_500), pessimista: R(-20_880) });
    expect(dash.kpis.mesesRisco.pessimista).toEqual({ abaixoReserva: 8, negativos: 2 });
    expect(dash.series.composicao.map((c) => c.group)).toEqual(["pessoal", "operacional", "tributos", "financeiro", "crescimento", "outras"]);
    expect(dash.series.cenarios).toHaveLength(3);
    expect(dash.series.cenarios[2].months[11]).toEqual({ month: "2027-09", balanceCents: R(-20_880) });
    expect(dash.alerts.map((a) => a.code)).toEqual(["negativo_pessimista", "concentracao_categoria"]);
    expect(dash.alerts[0].text).toContain("ago/2027");
  });

  it("recalcular é idempotente e não altera nada nos módulos existentes", async () => {
    const env = createTestEnv();
    await seedSources(env);
    const deps = buildDeps(env);
    const viewer = await sessionFor(env, "viewer");
    const snapshot = JSON.stringify({ p: env.db.payables, y: env.db.payments, r: env.db.receivables, c: env.db.receipts, t: env.db.bankTransactions, m: env.db.reconciliations });

    const a = await recalculateCashflow(deps, viewer, { ano: String(YEAR) });
    const b = await recalculateCashflow(deps, viewer, { ano: String(YEAR) });
    expect(a).toMatchObject({ year: YEAR, lancamentos: 3, excluidos: { extrato_mock: 1 } });
    expect({ ...a, atualizadoEm: undefined }).toEqual({ ...b, atualizadoEm: undefined });
    expect(a.atualizadoEm).toBe(env.clock.now().toISOString());
    expect(JSON.stringify({ p: env.db.payables, y: env.db.payments, r: env.db.receivables, c: env.db.receipts, t: env.db.bankTransactions, m: env.db.reconciliations })).toBe(snapshot);
    expect(env.db.auditRecords.filter((a2) => a2.action.startsWith("cashflow."))).toHaveLength(0);
  });
});
