/**
 * Fase 6 — testes de ACEITAÇÃO da disciplina Fluxo de Caixa, ponta a ponta
 * pela API (handlers puros + adaptador em memória), um bloco por exigência
 * do prompt:
 *  1. dataset de referência da planilha, ao centavo, e exportar → reimportar
 *     preserva os totais;
 *  2. título pago E conciliado não duplica;
 *  3. pago sem conciliação: fallback declarado (padrão) e modo estrito
 *     (`?estrito=1`) → permanece previsto;
 *  4. transferência entre contas próprias é neutra;
 *  5. categoria não mapeada → a_classificar e /pendencias; classificar esvazia;
 *  6. recálculo duplo é idêntico;
 *  7. meses realizados = 0 sem divisão por zero.
 */
import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { buildRegistry } from "@/skills";
import { readXlsx } from "@/lib/importers/xlsx-reader";
import type { ApiDeps, ApiSession } from "../_lib/handlers";
import {
  createCashflowManualEntry,
  exportCashflowWorkbook,
  getCashflowDashboard,
  getCashflowMonthly,
  getCashflowPending,
  getCashflowProjection,
  getCashflowVariance,
  importCashflowWorkbook,
  listCashflowEntries,
  putCashflowMapping,
  putCashflowParameters,
  recalculateCashflow,
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
const YEAR = 2026;
const ANO = { ano: String(YEAR) };
const ESTRITO = { ano: String(YEAR), estrito: "1" };

async function setup() {
  const env = createTestEnv();
  const deps = buildDeps(env);
  const manager = await sessionFor(env, "manager");
  return { env, deps, manager };
}

/** Fornecedor + duas contas bancárias (para conciliação e transferências). */
async function seedBancos(env: TestEnv) {
  const now = env.clock.now().toISOString();
  const co = env.company.id;
  await env.repos.suppliers.create({ id: "sup_1", companyId: co, name: "Light", document: "1", active: true, createdAt: now, updatedAt: now });
  for (const id of ["ba_1", "ba_2"]) {
    await env.repos.bankAccounts.create({ id, companyId: co, name: id, bankCode: "341", agency: "1", accountNumberMasked: "****", type: "checking", currency: "BRL", openingBalanceCents: 0, openingBalanceDate: "2026-01-01", active: true, createdAt: now, updatedAt: now });
  }
}

/** Título pago no app (pagamento executado em 18/08). */
async function seedPago(env: TestEnv, id = "pv1", amount = 10_000) {
  const now = env.clock.now().toISOString();
  const co = env.company.id;
  await env.repos.payables.create({ id, companyId: co, supplierId: "sup_1", description: "Folha de agosto", issueDate: "2026-08-01", dueDate: "2026-08-20", amountCents: amount, paidCents: amount, currency: "BRL", status: "paid", installmentNumber: 1, installmentCount: 1, originKey: `k_${id}`, supplierCategory: "Folha", createdBy: "u", createdAt: now, updatedAt: now });
  await env.repos.payments.create({ id: `pay_${id}`, companyId: co, payableId: id, bankAccountId: "ba_1", amountCents: amount, scheduledDate: "2026-08-18", executedAt: "2026-08-18T12:00:00.000Z", status: "executed", requestedBy: "u", createdAt: now, updatedAt: now });
}

/** Dataset de referência da planilha: realizado jul/ago/set + previsto out. */
const DATASET: Array<[number, string, "entrada" | "saida", number, "previsto" | "realizado"]> = [
  [7, "prestacao_servicos", "entrada", 92_000, "realizado"],
  [7, "folha_salarios", "saida", 48_000, "realizado"],
  [7, "simples_nacional_das", "saida", 9_400, "realizado"],
  [8, "prestacao_servicos", "entrada", 76_000, "realizado"],
  [8, "folha_salarios", "saida", 48_000, "realizado"],
  [8, "fornecedores", "saida", 31_000, "realizado"],
  [8, "software_assinaturas", "saida", 4_200, "realizado"],
  [9, "vendas_produtos", "entrada", 58_000, "realizado"],
  [9, "folha_salarios", "saida", 49_500, "realizado"],
  [9, "aluguel", "saida", 12_800, "realizado"],
  [10, "prestacao_servicos", "entrada", 110_000, "previsto"],
  [10, "materiais_equipamentos", "saida", 44_000, "previsto"],
];

async function seedReferencia(deps: ApiDeps, manager: ApiSession) {
  await putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: R(85_000), minimumReserveCents: R(60_000), realizedMonthsOverride: 3 });
  for (const [m, categoryId, kind, reais, status] of DATASET) {
    await createCashflowManualEntry(deps, manager, {
      competenceDate: `${YEAR}-${String(m).padStart(2, "0")}-15`,
      kind,
      categoryId,
      description: `${categoryId} ${m}`,
      status,
      amountCents: R(reais),
    });
  }
}

/** Percorre a resposta e devolve os caminhos com NaN/±Infinity. */
function naoFinitos(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => naoFinitos(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => naoFinitos(v, `${path}.${k}`));
  return [];
}

describe("Aceite 1 — dataset de referência da planilha (ao centavo) e exportar → reimportar preserva totais", () => {
  it("Fluxo Mensal, Previsto x Realizado, Projeção e Dashboard reproduzem a planilha", async () => {
    const { deps, manager } = await setup();
    await seedReferencia(deps, manager);

    const { monthly } = await getCashflowMonthly(deps, manager, ANO);
    expect(monthly.entradasAnoCents).toBe(R(336_000));
    expect(monthly.saidasAnoCents).toBe(R(246_900));
    expect(monthly.resultadoAnoCents).toBe(R(89_100));
    expect(monthly.saldoFinal.slice(6, 10)).toEqual([R(119_600), R(112_400), R(108_100), R(174_100)]);
    expect(monthly.saldoFinal[11]).toBe(R(174_100));
    expect(monthly.situacao.every((s) => s === "ok")).toBe(true);
    expect(monthly.rows).toHaveLength(37);
    expect(monthly.naoClassificadosCount).toBe(0);

    const { variance } = await getCashflowVariance(deps, manager, ANO);
    const entradas = variance.lines.find((l) => l.key === "entradas")!;
    expect([entradas.realizadoAnoCents, entradas.previstoAnoCents, entradas.variacao[9]]).toEqual([R(226_000), R(110_000), R(-110_000)]);

    const { projection } = await getCashflowProjection(deps, manager, ANO);
    expect(projection).toMatchObject({ realizedMonths: 3, realizedMonthsSource: "override", avgInCents: R(75_333.33), avgOutCents: R(67_633.33), startingBalanceCents: R(108_100), startMonth: "2026-10", lowConfidence: false });
    const by = (code: string) => projection.scenarios.find((s) => s.code === code)!;
    expect([by("otimista").balance12Cents, by("realista").balance12Cents, by("pessimista").balance12Cents]).toEqual([R(336_100), R(200_500), R(-20_880)]);
    expect(by("pessimista")).toMatchObject({ monthsBelowReserve: 8, monthsNegative: 2, firstNegative: { month: "2027-08", balanceCents: R(-10_131.67) } });

    const dash = await getCashflowDashboard(deps, manager, ANO);
    expect(dash.kpis).toMatchObject({ entradasAnoCents: R(336_000), saidasAnoCents: R(246_900), resultadoAnoCents: R(89_100), saldoFinalAnoCents: R(174_100), realizedMonths: 3, lowConfidence: false });
    expect(dash.kpis.saldo12MesesCents).toMatchObject({ otimista: R(336_100), realista: R(200_500), pessimista: R(-20_880) });
    expect(dash.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(["negativo_pessimista", "concentracao_categoria"]));
    expect(dash.alerts.find((a) => a.code === "concentracao_categoria")!.text).toContain("58,9%");
    expect(dash.parameterConfigured).toBe(true);
  });

  it("exportar e reimportar preserva os totais: nada é criado e as grades ficam idênticas", async () => {
    const { env, deps, manager } = await setup();
    await seedReferencia(deps, manager);
    const antes = await getCashflowMonthly(deps, manager, ANO);
    const file = await exportCashflowWorkbook(deps, manager, ANO);
    const wb = readXlsx(file.bytes);
    expect(wb.sheetNames).toHaveLength(7);
    expect(wb.readSheet("Lançamentos")!.maxRow).toBe(DATASET.length + 1);

    const report = await importCashflowWorkbook(deps, manager, { fileName: file.filename, bytes: file.bytes });
    expect(report).toMatchObject({ resultado: "aplicado", criadas: 0, linhasLidas: DATASET.length, erros: [] });
    expect(report.ignoradas.every((s) => s.motivo === "ja_existente")).toBe(true);
    expect(report.ignoradas).toHaveLength(DATASET.length);

    const depois = await getCashflowMonthly(deps, manager, ANO);
    expect(depois.monthly).toEqual(antes.monthly);
    expect(await env.repos.cashflowManualEntries.listAll(env.company.id)).toHaveLength(DATASET.length);
  });
});

describe("Aceite 2 — título pago E conciliado entra UMA vez", () => {
  it("o realizado vem da conciliação (data do movimento) e o pagamento é consumido; totais contam o valor uma única vez", async () => {
    const { env, deps, manager } = await setup();
    await seedBancos(env);
    await seedPago(env);
    const now = env.clock.now().toISOString();
    await env.repos.bankTransactions.create({ id: "tx1", companyId: env.company.id, bankAccountId: "ba_1", date: "2026-08-19", amountCents: -10_000, currency: "BRL", description: "PIX FOLHA", source: "ofx", reconciled: true, createdAt: now });
    await env.repos.reconciliations.create({ id: "mt1", companyId: env.company.id, bankTransactionId: "tx1", targetType: "payment", targetId: "pay_pv1", confidence: 1, status: "confirmed", matchedBy: "u", createdAt: now, updatedAt: now });
    await putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "Folha", categoryId: "folha_salarios" });

    const page = await listCashflowEntries(deps, manager, ANO);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ origin: "conciliacao", originId: "tx1", status: "realizado", realizedBy: "conciliacao", kind: "saida", amountCents: 10_000, categoryId: "folha_salarios", cashDate: "2026-08-19", competenceDate: "2026-08-01" });
    expect(page.items[0].parentId).toBeUndefined();
    expect(page.totals).toEqual({ entradasCents: 0, saidasCents: 10_000, liquidoCents: -10_000 });
    const { monthly } = await getCashflowMonthly(deps, manager, ANO);
    expect(monthly.saidasAnoCents).toBe(10_000);
    expect(monthly.rows.find((r) => r.categoryId === "folha_salarios")!.months[7]).toBe(10_000);
    const recalculo = await recalculateCashflow(deps, manager, ANO);
    expect(recalculo.lancamentos).toBe(1);
    expect(recalculo.excluidos).toEqual({});
  });
});

describe("Aceite 3 — pago sem conciliação: fallback declarado por padrão; modo estrito mantém previsto", () => {
  it("padrão: realizado por baixa_app com o critério declarado; ?estrito=1: previsto, e o realizado só existe pela conciliação", async () => {
    const { env, deps, manager } = await setup();
    await seedBancos(env);
    await seedPago(env);
    await putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "Folha", categoryId: "folha_salarios" });

    const padrao = await listCashflowEntries(deps, manager, ANO);
    expect(padrao.items[0]).toMatchObject({ status: "realizado", realizedBy: "baixa_app", origin: "contas_pagar", originId: "pay_pv1", parentId: "pv1", cashDate: "2026-08-18" });
    expect(padrao.items[0].matchCriteria).toMatch(/fallback declarado/);

    const estrito = await listCashflowEntries(deps, manager, ESTRITO);
    expect(estrito.items[0]).toMatchObject({ status: "previsto", origin: "contas_pagar", originId: "pay_pv1", amountCents: 10_000 });
    expect(estrito.items[0].realizedBy).toBeUndefined();
    expect(estrito.items[0].matchCriteria).toMatch(/modo estrito/);

    // Totais (previsto + realizado) não mudam entre os modos; Previsto x Realizado muda de coluna.
    const mPadrao = await getCashflowMonthly(deps, manager, ANO);
    const mEstrito = await getCashflowMonthly(deps, manager, ESTRITO);
    expect(mPadrao.modoEstrito).toBe(false);
    expect(mEstrito.modoEstrito).toBe(true);
    expect(mEstrito.monthly.saidasAnoCents).toBe(mPadrao.monthly.saidasAnoCents);
    const saidasPadrao = (await getCashflowVariance(deps, manager, ANO)).variance.lines.find((l) => l.key === "saidas")!;
    const saidasEstrito = (await getCashflowVariance(deps, manager, ESTRITO)).variance.lines.find((l) => l.key === "saidas")!;
    expect([saidasPadrao.realizado[7], saidasPadrao.previsto[7]]).toEqual([10_000, 0]);
    expect([saidasEstrito.realizado[7], saidasEstrito.previsto[7]]).toEqual([0, 10_000]);

    // No modo estrito não há mês realizado: a projeção parte do saldo inicial, sem dividir por zero.
    const pEstrito = (await getCashflowProjection(deps, manager, ESTRITO)).projection;
    expect(pEstrito).toMatchObject({ realizedMonths: 0, avgOutCents: 0, lowConfidence: true });
    const pPadrao = (await getCashflowProjection(deps, manager, ANO)).projection;
    expect(pPadrao.realizedMonths).toBe(1);

    // A planilha exportada respeita o modo.
    const lanc = (mode: Record<string, string>) => exportCashflowWorkbook(deps, manager, mode).then((f) => readXlsx(f.bytes).readSheet("Lançamentos")!.cells.get("F2")!.value);
    expect(await lanc(ANO)).toBe("Realizado");
    expect(await lanc(ESTRITO)).toBe("Previsto");
  });
});

describe("Aceite 4 — transferência entre contas próprias é neutra", () => {
  it("par espelhado (±1 dia) e match explícito 'transfer' ficam fora do fluxo; movimento sem conciliação também não entra", async () => {
    const { env, deps, manager } = await setup();
    await seedBancos(env);
    const now = env.clock.now().toISOString();
    const co = env.company.id;
    const tx = (id: string, bankAccountId: string, date: string, amountCents: number, description: string) =>
      env.repos.bankTransactions.create({ id, companyId: co, bankAccountId, date, amountCents, currency: "BRL", description, source: "ofx", reconciled: false, createdAt: now });
    await tx("out", "ba_1", "2026-08-18", -500_000, "TED ENTRE CONTAS");
    await tx("in", "ba_2", "2026-08-19", 500_000, "TED RECEBIDA");
    await tx("out2", "ba_1", "2026-08-25", -120_000, "TRANSF POUPANCA");
    await tx("in2", "ba_2", "2026-08-25", 120_000, "TRANSF POUPANCA");
    await env.repos.reconciliations.create({ id: "t1", companyId: co, bankTransactionId: "out2", targetType: "transfer", targetId: "in2", groupId: "g1", confidence: 1, status: "confirmed", matchedBy: "u", createdAt: now, updatedAt: now });
    await env.repos.reconciliations.create({ id: "t2", companyId: co, bankTransactionId: "in2", targetType: "transfer", targetId: "out2", groupId: "g1", confidence: 1, status: "confirmed", matchedBy: "u", createdAt: now, updatedAt: now });
    await tx("solto", "ba_1", "2026-08-27", -3_000, "TARIFA SEM CONCILIAR");

    const recalculo = await recalculateCashflow(deps, manager, ANO);
    expect(recalculo.lancamentos).toBe(0);
    expect(recalculo.excluidos.transferencia_interna).toBe(4);
    expect(recalculo.excluidos.sem_conciliacao).toBe(1);
    const { monthly } = await getCashflowMonthly(deps, manager, ANO);
    expect(monthly.entradasAnoCents).toBe(0);
    expect(monthly.saidasAnoCents).toBe(0);
    expect((await listCashflowEntries(deps, manager, ANO)).total).toBe(0);
  });
});

describe("Aceite 5 — categoria não mapeada cai em a_classificar e aparece em /pendencias", () => {
  it("classificar em um clique grava o de-para, esvazia a fila e reclassifica o lançamento", async () => {
    const { env, deps, manager } = await setup();
    await seedBancos(env);
    const now = env.clock.now().toISOString();
    await env.repos.payables.create({ id: "pv_luz", companyId: env.company.id, supplierId: "sup_1", description: "Energia sala 1235", issueDate: "2026-08-01", dueDate: "2026-09-10", amountCents: 90_000, paidCents: 0, currency: "BRL", status: "open", installmentNumber: 1, installmentCount: 1, originKey: "k_luz", supplierCategory: "Concessionaria - Energia", createdBy: "u", createdAt: now, updatedAt: now });

    const antes = await listCashflowEntries(deps, manager, ANO);
    expect(antes.items[0]).toMatchObject({ categoryId: "a_classificar", mappingSource: "nao_mapeado", status: "previsto", month: 9, amountCents: 90_000 });
    expect((await getCashflowDashboard(deps, manager, ANO)).naoClassificados).toEqual({ count: 1, totalCents: 90_000 });
    const fila = await getCashflowPending(deps, manager, ANO);
    expect(fila.total).toBe(1);
    expect(fila.groups[0]).toMatchObject({ source: "categoria_ap", sourceKey: "Concessionaria - Energia", count: 1, totalCents: 90_000, kinds: ["saida"], originIds: ["pv_luz"] });

    const { created } = await putCashflowMapping(deps, manager, { source: "categoria_ap", sourceKey: "Concessionaria - Energia", categoryId: "energia_eletrica" });
    expect(created).toBe(true);
    expect((await getCashflowPending(deps, manager, ANO)).total).toBe(0);
    const depois = await listCashflowEntries(deps, manager, ANO);
    expect(depois.items[0]).toMatchObject({ categoryId: "energia_eletrica", mappingSource: "categoria_ap", group: "operacional" });
    const { monthly } = await getCashflowMonthly(deps, manager, ANO);
    expect(monthly.naoClassificadosCount).toBe(0);
    expect(monthly.rows.find((r) => r.categoryId === "energia_eletrica")!.months[8]).toBe(90_000);
  });
});

describe("Aceite 6 — recálculo duplo é idêntico", () => {
  it("duas chamadas seguidas devolvem exatamente o mesmo resultado, sem escrever nos módulos existentes", async () => {
    const { env, deps, manager } = await setup();
    await seedBancos(env);
    await seedPago(env);
    await seedReferencia(deps, manager);
    const payablesAntes = JSON.stringify(await env.repos.payables.listAll(env.company.id));
    const paymentsAntes = JSON.stringify(await env.repos.payments.listAll(env.company.id));

    const r1 = await recalculateCashflow(deps, manager, ANO);
    const r2 = await recalculateCashflow(deps, manager, ANO);
    expect(r2).toEqual(r1);
    expect(r1.lancamentos).toBe(DATASET.length + 1);

    const d1 = await getCashflowDashboard(deps, manager, ANO);
    const d2 = await getCashflowDashboard(deps, manager, ANO);
    expect(d2).toEqual(d1);
    const m1 = await getCashflowMonthly(deps, manager, ANO);
    const m2 = await getCashflowMonthly(deps, manager, ANO);
    expect(m2).toEqual(m1);
    const p1 = await getCashflowProjection(deps, manager, ANO);
    const p2 = await getCashflowProjection(deps, manager, ANO);
    expect(p2).toEqual(p1);

    expect(JSON.stringify(await env.repos.payables.listAll(env.company.id))).toBe(payablesAntes);
    expect(JSON.stringify(await env.repos.payments.listAll(env.company.id))).toBe(paymentsAntes);
    expect(env.db.auditRecords.filter((a) => a.action.startsWith("cashflow.") && !/parameter|scenario|manual_entry/.test(a.action))).toHaveLength(0);
  });
});

describe("Aceite 7 — meses realizados = 0 não divide por zero", () => {
  it("só previstos: médias zero, projeção plana no saldo inicial, aviso de confiabilidade, dashboard e planilha sem NaN/Infinity", async () => {
    const { deps, manager } = await setup();
    await putCashflowParameters(deps, manager, { year: YEAR, openingBalanceCents: R(85_000), minimumReserveCents: R(60_000) });
    await createCashflowManualEntry(deps, manager, { competenceDate: "2026-10-15", kind: "entrada", categoryId: "prestacao_servicos", description: "Contrato previsto", status: "previsto", amountCents: R(110_000) });
    await createCashflowManualEntry(deps, manager, { competenceDate: "2026-10-15", kind: "saida", categoryId: "materiais_equipamentos", description: "Compra prevista", status: "previsto", amountCents: R(44_000) });

    const { projection } = await getCashflowProjection(deps, manager, ANO);
    expect(projection).toMatchObject({ realizedMonths: 0, realizedMonthsSource: "calculado", realizedInCents: 0, realizedOutCents: 0, avgInCents: 0, avgOutCents: 0, startingBalanceCents: R(85_000), lowConfidence: true });
    expect(projection.warnings.some((w) => /realizado/i.test(w))).toBe(true);
    for (const sc of projection.scenarios) {
      expect(sc.months).toHaveLength(12);
      expect(sc.months.every((m) => m.inCents === 0 && m.outCents === 0 && m.balanceCents === R(85_000))).toBe(true);
      expect([sc.monthsBelowReserve, sc.monthsNegative, sc.balance12Cents]).toEqual([0, 0, R(85_000)]);
    }
    expect(naoFinitos(projection)).toEqual([]);

    const dash = await getCashflowDashboard(deps, manager, ANO);
    expect(dash.kpis).toMatchObject({ realizedMonths: 0, lowConfidence: true, entradasAnoCents: R(110_000), saidasAnoCents: R(44_000), saldoFinalAnoCents: R(151_000) });
    expect(dash.kpis.saldo12MesesCents).toMatchObject({ otimista: R(85_000), realista: R(85_000), pessimista: R(85_000) });
    expect(dash.warnings.some((w) => /confiabilidade|realizado/i.test(w))).toBe(true);
    expect(naoFinitos(dash)).toEqual([]);

    const file = await exportCashflowWorkbook(deps, manager, ANO);
    const pj = readXlsx(file.bytes).readSheet("Projeção")!;
    expect(pj.cells.get("C3")).toEqual({ type: "n", value: 0 });
    expect(pj.cells.get("C6")).toEqual({ type: "n", value: 0 });
    expect(pj.cells.get("C8")).toEqual({ type: "n", value: 85_000 });
    expect(pj.cells.get("N17")).toEqual({ type: "n", value: 85_000 });
  });
});
