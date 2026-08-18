import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Category, Payable, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  controladoriaSkill,
  type CostStructureData,
  type DreData,
  type ExplainIndicatorData,
  type IndicatorEntry,
  type IndicatorsData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.
// Janela de 90 dias do PMR/PMP: 2026-05-21 a 2026-08-18.
const PERIOD = "2026-07";

let seedSeq = 0;

function seedCategory(env: TestEnv, over: Partial<Category>): Category {
  const category: Category = {
    id: `cat_${++seedSeq}`,
    companyId: env.company.id,
    name: "Categoria",
    kind: "expense",
    dreGroup: "despesas_operacionais",
    active: true,
    ...over,
  };
  env.db.categories.push(category);
  return category;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable>): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `recv_seed_${++seedSeq}`;
  const receivable: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Recebível semeado",
    issueDate: "2026-07-10",
    dueDate: "2026-08-10",
    amountCents: 100_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}:1/1`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.receivables.push(receivable);
  return receivable;
}

function seedPayable(env: TestEnv, over: Partial<Payable>): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_seed_${++seedSeq}`;
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Pagável semeado",
    issueDate: "2026-07-10",
    dueDate: "2026-08-10",
    amountCents: 100_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}:1/1`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(payable);
  return payable;
}

/**
 * Cenário base (valores redondos, julho/2026):
 *   receita_bruta          10.000.000 (recebível "Vendas")
 *   receitas_financeiras      100.000 (recebível "Rendimentos")
 *   deducoes                1.000.000 (pagável "Impostos sobre Vendas")
 *   custos                  3.000.000 (pagável "CMV")
 *   despesas_operacionais   2.000.000 (pagável "Despesas Administrativas")
 *   despesas_financeiras      200.000 (pagável "Juros e Tarifas")
 *   outras                     50.000 (pagável SEM categoria)
 * Fora do período/da DRE: recebível cancelado (999.999), recebível de junho já
 * recebido (2.000.000) e pagável de junho já pago (1.000.000) — os dois últimos
 * entram só na janela de 90 dias do PMR/PMP.
 */
function buildScenario(env: TestEnv) {
  const catVendas = seedCategory(env, {
    id: "cat_vendas",
    name: "Vendas de Mercadorias",
    kind: "income",
    dreGroup: "receita_bruta",
  });
  const catRend = seedCategory(env, {
    id: "cat_rend",
    name: "Rendimentos de Aplicação",
    kind: "income",
    dreGroup: "receitas_financeiras",
  });
  const catImp = seedCategory(env, {
    id: "cat_imp",
    name: "Impostos sobre Vendas",
    dreGroup: "deducoes",
  });
  const catCmv = seedCategory(env, { id: "cat_cmv", name: "CMV", dreGroup: "custos" });
  const catAdm = seedCategory(env, {
    id: "cat_adm",
    name: "Despesas Administrativas",
    dreGroup: "despesas_operacionais",
  });
  const catJur = seedCategory(env, {
    id: "cat_jur",
    name: "Juros e Tarifas",
    dreGroup: "despesas_financeiras",
  });

  seedReceivable(env, {
    id: "recv_vendas",
    categoryId: catVendas.id,
    issueDate: "2026-07-10",
    amountCents: 10_000_000,
  });
  seedReceivable(env, {
    id: "recv_rend",
    categoryId: catRend.id,
    issueDate: "2026-07-15",
    amountCents: 100_000,
  });
  seedReceivable(env, {
    id: "recv_cancelado",
    categoryId: catVendas.id,
    issueDate: "2026-07-20",
    amountCents: 999_999,
    status: "canceled",
    canceledAt: env.clock.now().toISOString(),
  });
  seedReceivable(env, {
    id: "recv_junho",
    categoryId: catVendas.id,
    issueDate: "2026-06-05",
    dueDate: "2026-07-05",
    amountCents: 2_000_000,
    receivedCents: 2_000_000,
    status: "received",
  });

  seedPayable(env, {
    id: "payb_imp",
    categoryId: catImp.id,
    issueDate: "2026-07-05",
    amountCents: 1_000_000,
  });
  seedPayable(env, {
    id: "payb_cmv",
    categoryId: catCmv.id,
    issueDate: "2026-07-08",
    amountCents: 3_000_000,
  });
  seedPayable(env, {
    id: "payb_adm",
    categoryId: catAdm.id,
    issueDate: "2026-07-12",
    amountCents: 2_000_000,
  });
  seedPayable(env, {
    id: "payb_jur",
    categoryId: catJur.id,
    issueDate: "2026-07-18",
    amountCents: 200_000,
  });
  seedPayable(env, {
    id: "payb_semcat",
    issueDate: "2026-07-25",
    amountCents: 50_000,
  });
  seedPayable(env, {
    id: "payb_junho",
    categoryId: catCmv.id,
    issueDate: "2026-06-10",
    dueDate: "2026-07-10",
    amountCents: 1_000_000,
    paidCents: 1_000_000,
    status: "paid",
  });
}

async function run(env: TestEnv, input: unknown) {
  return runSkill(controladoriaSkill, env.ctx(env.actorFor("analyst")), input);
}

function indicator(data: IndicatorsData, key: string): IndicatorEntry {
  const entry = data.indicators.find((i) => i.key === key);
  expect(entry, `indicador ${key} ausente`).toBeDefined();
  return entry as IndicatorEntry;
}

// ---------------------------------------------------------------------------
// dre
// ---------------------------------------------------------------------------

describe("controladoria_indicadores — dre", () => {
  it("apura cada linha da DRE por competência com valores exatos", async () => {
    const env = createTestEnv();
    buildScenario(env);

    const res = await run(env, { action: "dre", period: PERIOD });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);

    const data = res.data as DreData;
    expect(data.period).toBe(PERIOD);
    expect(data.regime).toBe("competencia");
    expect(data.dre).toEqual({
      receitaBrutaCents: 10_000_000,
      deducoesCents: 1_000_000,
      receitaLiquidaCents: 9_000_000, // 10.000.000 - 1.000.000
      custosCents: 3_000_000,
      lucroBrutoCents: 6_000_000, // 9.000.000 - 3.000.000
      despesasOperacionaisCents: 2_000_000,
      ebitdaCents: 4_000_000, // 6.000.000 - 2.000.000
      resultadoFinanceiroCents: -100_000, // 100.000 - 200.000
      resultadoCents: 3_900_000, // 4.000.000 + (-100.000)
      outrasCents: 50_000,
    });
    expect(data.formula).toContain("receitaLiquida = receitaBruta - deducoes");
    expect(data.formula).toContain("competência");
    expect(res.assumptions.some((a) => a.includes("COMPETÊNCIA"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("EBITDA"))).toBe(true);
    expect(res.audit.data_sources).toContain("payables");
    expect(res.audit.data_sources).toContain("receivables");
  });

  it("detalha o breakdown por grupo/categoria e aponta títulos sem categoria", async () => {
    const env = createTestEnv();
    buildScenario(env);

    const res = await run(env, { action: "dre", period: PERIOD });
    const data = res.data as DreData;

    expect(data.breakdown).toEqual([
      {
        dreGroup: "receita_bruta",
        categoryId: "cat_vendas",
        categoryName: "Vendas de Mercadorias",
        amountCents: 10_000_000,
      },
      {
        dreGroup: "deducoes",
        categoryId: "cat_imp",
        categoryName: "Impostos sobre Vendas",
        amountCents: 1_000_000,
      },
      { dreGroup: "custos", categoryId: "cat_cmv", categoryName: "CMV", amountCents: 3_000_000 },
      {
        dreGroup: "despesas_operacionais",
        categoryId: "cat_adm",
        categoryName: "Despesas Administrativas",
        amountCents: 2_000_000,
      },
      {
        dreGroup: "receitas_financeiras",
        categoryId: "cat_rend",
        categoryName: "Rendimentos de Aplicação",
        amountCents: 100_000,
      },
      {
        dreGroup: "despesas_financeiras",
        categoryId: "cat_jur",
        categoryName: "Juros e Tarifas",
        amountCents: 200_000,
      },
      { dreGroup: "outras", categoryId: null, categoryName: "Sem categoria", amountCents: 50_000 },
    ]);

    expect(res.pending_items).toHaveLength(1);
    expect(res.pending_items[0]).toMatchObject({
      code: "titulo_sem_categoria",
      entityType: "payable",
      entityId: "payb_semcat",
    });
    expect(res.assumptions.some((a) => a.includes('grupo "outras"'))).toBe(true);
  });

  it("período sem movimento devolve DRE zerada com sucesso", async () => {
    const env = createTestEnv();
    buildScenario(env);

    const res = await run(env, { action: "dre", period: "2026-03" });
    expect(res.status).toBe("success");
    const data = res.data as DreData;
    expect(data.breakdown).toEqual([]);
    expect(data.dre.receitaBrutaCents).toBe(0);
    expect(data.dre.resultadoCents).toBe(0);
  });

  it("é determinística e idempotente: repetir não muda dados nem duplica alertas", async () => {
    const env = createTestEnv();
    // Só despesa → resultado negativo → alerta persistido.
    seedCategory(env, { id: "cat_adm", name: "Despesas Administrativas" });
    seedPayable(env, { categoryId: "cat_adm", issueDate: "2026-01-15", amountCents: 500_000 });

    const res1 = await run(env, { action: "dre", period: "2026-01" });
    const res2 = await run(env, { action: "dre", period: "2026-01" });

    expect(res1.status).toBe("warning");
    expect((res1.data as DreData).dre.resultadoCents).toBe(-500_000);
    expect(res1.alerts.some((a) => a.code === "dre_resultado_negativo")).toBe(true);
    expect(res2.data).toEqual(res1.data);

    const persisted = env.db.alerts.filter((a) => a.code === "dre_resultado_negativo");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].source).toBe("controladoria_indicadores");
  });

  it("rejeita período mal formado", async () => {
    const env = createTestEnv();
    const res = await run(env, { action: "dre", period: "2026-13" });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

describe("controladoria_indicadores — indicators", () => {
  it("calcula todos os indicadores com matemática exata", async () => {
    const env = createTestEnv();
    buildScenario(env);

    const res = await run(env, { action: "indicators", period: PERIOD });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    const data = res.data as IndicatorsData;
    expect(data.period).toBe(PERIOD);

    // margem_bruta = 6.000.000 / 9.000.000 × 100 = 66,67%
    expect(indicator(data, "margem_bruta").valuePercent).toBe(66.67);
    // margem_operacional = 4.000.000 / 9.000.000 × 100 = 44,44%
    expect(indicator(data, "margem_operacional").valuePercent).toBe(44.44);
    expect(indicator(data, "ebitda_gerencial").valueCents).toBe(4_000_000);

    // Ponto de equilíbrio: fixos = 2.000.000; variáveis = 3.000.000 + 1.000.000;
    // MC = (9.000.000 − 4.000.000) / 10.000.000 = 0,5 → PE = 2.000.000 / 0,5 = 4.000.000.
    expect(indicator(data, "ponto_equilibrio").valueCents).toBe(4_000_000);

    // Capital de giro: AR aberto (10.000.000 + 100.000) − AP aberto
    // (1.000.000 + 3.000.000 + 2.000.000 + 200.000 + 50.000) = 3.850.000.
    expect(indicator(data, "capital_giro").valueCents).toBe(3_850_000);

    // PMR = 10.100.000 / 12.100.000 × 90 = 75,12 → 75 dias
    // (receita 90d inclui o recebível de junho de 2.000.000; exclui o cancelado).
    expect(indicator(data, "pmr").valueDays).toBe(75);
    // PMP = 6.250.000 / 7.250.000 × 90 = 77,59 → 78 dias (compras 90d incluem junho pago).
    expect(indicator(data, "pmp").valueDays).toBe(78);
    // Ciclo financeiro = PMR − PMP = 75 − 78 = −3 dias.
    expect(indicator(data, "ciclo_financeiro").valueDays).toBe(-3);

    // Saídas do período = 6.250.000; fixos = 2.000.000 (32%); variáveis = 4.000.000 (64%).
    expect(indicator(data, "custos_fixos_pct").valuePercent).toBe(32);
    expect(indicator(data, "custos_variaveis_pct").valuePercent).toBe(64);

    // Todo indicador declara fórmula, período, fontes e explicação simples.
    for (const entry of data.indicators) {
      expect(entry.formula.length).toBeGreaterThan(0);
      expect(entry.period.length).toBeGreaterThan(0);
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.explanation.length).toBeGreaterThan(0);
    }
    expect(indicator(data, "pmr").period).toBe("2026-05-21 a 2026-08-18");
    expect(res.assumptions.some((a) => a.includes("FIXOS"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("sem estoque"))).toBe(true);
  });

  it("período sem receita: margens e ponto de equilíbrio nulos, com suposições", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "cat_adm", name: "Despesas Administrativas" });
    // Fora da janela de 90 dias (emitido em janeiro) e ainda em aberto hoje.
    seedPayable(env, { categoryId: "cat_adm", issueDate: "2026-01-15", amountCents: 500_000 });

    const res = await run(env, { action: "indicators", period: "2026-01" });
    const data = res.data as IndicatorsData;

    expect(indicator(data, "margem_bruta").valuePercent).toBeNull();
    expect(indicator(data, "margem_operacional").valuePercent).toBeNull();
    expect(indicator(data, "ponto_equilibrio").valueCents).toBeNull();
    expect(indicator(data, "ebitda_gerencial").valueCents).toBe(-500_000);
    expect(indicator(data, "pmr").valueDays).toBeNull();
    expect(indicator(data, "pmp").valueDays).toBeNull();
    expect(indicator(data, "ciclo_financeiro").valueDays).toBeNull();
    expect(indicator(data, "custos_fixos_pct").valuePercent).toBe(100);
    expect(indicator(data, "custos_variaveis_pct").valuePercent).toBe(0);

    expect(res.assumptions.some((a) => a.includes("Receita líquida não positiva"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("Receita bruta zerada"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("PMR não calculado"))).toBe(true);
    expect(res.assumptions.some((a) => a.includes("PMP não calculado"))).toBe(true);
  });

  it("capital de giro negativo gera alerta persistido, sem duplicar em reexecução", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "cat_adm", name: "Despesas Administrativas" });
    seedPayable(env, { categoryId: "cat_adm", issueDate: "2026-01-15", amountCents: 500_000 });

    const res1 = await run(env, { action: "indicators", period: "2026-01" });
    const res2 = await run(env, { action: "indicators", period: "2026-01" });

    expect((res1.data as IndicatorsData).indicators.find((i) => i.key === "capital_giro")?.valueCents).toBe(
      -500_000
    );
    expect(res1.status).toBe("warning");
    expect(res1.alerts.some((a) => a.code === "capital_giro_negativo")).toBe(true);
    expect(res2.data).toEqual(res1.data);
    expect(env.db.alerts.filter((a) => a.code === "capital_giro_negativo")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cost_structure
// ---------------------------------------------------------------------------

describe("controladoria_indicadores — cost_structure", () => {
  it("separa fixos, variáveis e outros por categoria com percentuais exatos", async () => {
    const env = createTestEnv();
    buildScenario(env);

    const res = await run(env, { action: "cost_structure", period: PERIOD });
    expect(res.status).toBe("success");
    const data = res.data as CostStructureData;

    expect(data.totals).toEqual({
      fixedCents: 2_000_000,
      variableCents: 4_000_000,
      otherCents: 250_000, // juros 200.000 + sem categoria 50.000
      totalOutflowsCents: 6_250_000,
      fixedPct: 32,
      variablePct: 64,
      otherPct: 4,
    });

    expect(data.fixed).toEqual([
      {
        categoryId: "cat_adm",
        categoryName: "Despesas Administrativas",
        dreGroup: "despesas_operacionais",
        classification: "fixo",
        amountCents: 2_000_000,
        pctOfTotal: 32,
      },
    ]);
    // Variáveis ordenados por valor decrescente: CMV (48%) antes de Impostos (16%).
    expect(data.variable.map((l) => [l.categoryId, l.amountCents, l.pctOfTotal])).toEqual([
      ["cat_cmv", 3_000_000, 48],
      ["cat_imp", 1_000_000, 16],
    ]);
    expect(data.other.map((l) => [l.categoryId, l.amountCents, l.pctOfTotal])).toEqual([
      ["cat_jur", 200_000, 3.2],
      [null, 50_000, 0.8],
    ]);
    expect(res.pending_items.some((p) => p.code === "saidas_sem_categoria")).toBe(true);
  });

  it("período sem saídas devolve totais zerados e percentuais nulos", async () => {
    const env = createTestEnv();
    buildScenario(env);

    const res = await run(env, { action: "cost_structure", period: "2026-03" });
    const data = res.data as CostStructureData;
    expect(data.totals.totalOutflowsCents).toBe(0);
    expect(data.totals.fixedPct).toBeNull();
    expect(data.totals.variablePct).toBeNull();
    expect(data.fixed).toEqual([]);
    expect(data.variable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// explain_indicator
// ---------------------------------------------------------------------------

describe("controladoria_indicadores — explain_indicator", () => {
  it("explica indicadores conhecidos com exemplo numérico em pt-BR", async () => {
    const env = createTestEnv();

    const res = await run(env, { action: "explain_indicator", indicator: "ponto_equilibrio" });
    expect(res.status).toBe("success");
    const data = res.data as ExplainIndicatorData;
    expect(data.indicator).toBe("ponto_equilibrio");
    expect(data.label).toBe("Ponto de equilíbrio");
    expect(data.explanation).toContain("prejuízo");
    expect(data.example).toContain("R$ 40.000,00");
  });

  it("normaliza a chave (maiúsculas/espaços) e aceita apelidos como dso", async () => {
    const env = createTestEnv();

    const pmr = await run(env, { action: "explain_indicator", indicator: "  PMR " });
    expect(pmr.status).toBe("success");
    expect((pmr.data as ExplainIndicatorData).label).toBe("Prazo médio de recebimento (PMR)");

    const dso = await run(env, { action: "explain_indicator", indicator: "dso" });
    expect(dso.status).toBe("success");

    const ebitda = await run(env, { action: "explain_indicator", indicator: "ebitda_gerencial" });
    expect((ebitda.data as ExplainIndicatorData).label).toBe("EBITDA gerencial");
  });

  it("indicador desconhecido devolve erro not_found", async () => {
    const env = createTestEnv();
    const res = await run(env, { action: "explain_indicator", indicator: "roi_da_sorte" });
    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Contratos gerais
// ---------------------------------------------------------------------------

describe("controladoria_indicadores — contratos", () => {
  it("não publica eventos e não movimenta dinheiro (somente leitura)", async () => {
    const env = createTestEnv();
    buildScenario(env);
    const payablesBefore = JSON.stringify(env.db.payables);
    const receivablesBefore = JSON.stringify(env.db.receivables);

    await run(env, { action: "dre", period: PERIOD });
    await run(env, { action: "indicators", period: PERIOD });
    await run(env, { action: "cost_structure", period: PERIOD });

    expect(controladoriaSkill.publishes).toEqual([]);
    expect(env.db.events.filter((e) => e.source === "controladoria_indicadores")).toEqual([]);
    expect(JSON.stringify(env.db.payables)).toBe(payablesBefore);
    expect(JSON.stringify(env.db.receivables)).toBe(receivablesBefore);
  });

  it("mantém o nome registrado pelo núcleo", () => {
    expect(controladoriaSkill.name).toBe("controladoria_indicadores");
  });
});
