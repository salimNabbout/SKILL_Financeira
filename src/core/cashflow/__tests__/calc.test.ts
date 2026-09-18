/**
 * Dataset de referência da planilha "Fluxo de Caixa CETEM" (Fase 6 da
 * especificação) — precisa bater AO CENTAVO.
 */
import { describe, expect, it } from "vitest";
import type { CashflowEntry, CashflowManualEntry, CashflowScenario } from "@/core/entities";
import { computeCashflow } from "..";
import { computeMonthly, computeVariance } from "../calc";
import { CASHFLOW_CATEGORY_PLAN, CASHFLOW_SCENARIO_SEED } from "../plan";
import { computeProjection } from "../projection";
import { unifyCashflow } from "../unify";

const YEAR = 2026;
const R = (reais: number) => Math.round(reais * 100);

function entry(
  month: number,
  categoryId: string,
  amountReais: number,
  status: CashflowEntry["status"],
  over: Partial<CashflowEntry> = {}
): CashflowEntry {
  const cat = CASHFLOW_CATEGORY_PLAN.find((c) => c.id === categoryId)!;
  const cashDate = `${YEAR}-${String(month).padStart(2, "0")}-15`;
  return {
    competenceDate: cashDate,
    cashDate,
    kind: cat.kind === "entrada" ? "entrada" : "saida",
    categoryId,
    group: cat.group,
    description: cat.name,
    status,
    realizedBy: status === "realizado" ? "baixa_app" : undefined,
    amountCents: R(amountReais),
    origin: "ajuste_manual",
    originId: `${categoryId}-${month}-${status}`,
    month,
    year: YEAR,
    ...over,
  };
}

const NOW = "2026-09-18T12:00:00.000Z";
const scenarios: CashflowScenario[] = CASHFLOW_SCENARIO_SEED.map((s) => ({
  id: `scn_${s.code}`,
  companyId: "co_1",
  code: s.code,
  name: s.name,
  revenueAdjustmentBp: s.revenueAdjustmentBp,
  expenseAdjustmentBp: s.expenseAdjustmentBp,
  monthlyGrowthBp: s.monthlyGrowthBp,
  active: true,
  createdBy: "usr",
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
}));

/** Realizado jul/ago/set + previsto out, exatamente como a especificação. */
const DATASET: CashflowEntry[] = [
  entry(7, "prestacao_servicos", 92_000, "realizado"),
  entry(7, "folha_salarios", 48_000, "realizado"),
  entry(7, "simples_nacional_das", 9_400, "realizado"),
  entry(8, "prestacao_servicos", 76_000, "realizado"),
  entry(8, "folha_salarios", 48_000, "realizado"),
  entry(8, "fornecedores", 31_000, "realizado"),
  entry(8, "software_assinaturas", 4_200, "realizado"),
  entry(9, "vendas_produtos", 58_000, "realizado"),
  entry(9, "folha_salarios", 49_500, "realizado"),
  entry(9, "aluguel", 12_800, "realizado"),
  entry(10, "prestacao_servicos", 110_000, "previsto"),
  entry(10, "materiais_equipamentos", 44_000, "previsto"),
];
const PARAM = { openingBalanceCents: R(85_000), minimumReserveCents: R(60_000), realizedMonthsOverride: 3 };

describe("Fluxo de Caixa — dataset de referência da planilha (ao centavo)", () => {
  const out = computeCashflow({ year: YEAR, entries: DATASET, categories: [...CASHFLOW_CATEGORY_PLAN], parameter: PARAM, scenarios });

  it("Fluxo Mensal: totais do ano, resultado e saldo encadeado", () => {
    expect(out.monthly.entradasAnoCents).toBe(R(336_000));
    expect(out.monthly.saidasAnoCents).toBe(R(246_900));
    expect(out.monthly.resultadoAnoCents).toBe(R(89_100));
    // jan..jun sem movimento: saldo inicial atravessa; jul..out encadeiam.
    expect(out.monthly.saldoInicial[0]).toBe(R(85_000));
    expect(out.monthly.saldoFinal.slice(0, 6)).toEqual(Array(6).fill(R(85_000)));
    expect(out.monthly.saldoFinal[6]).toBe(R(119_600));
    expect(out.monthly.saldoFinal[7]).toBe(R(112_400));
    expect(out.monthly.saldoFinal[8]).toBe(R(108_100));
    expect(out.monthly.saldoFinal[9]).toBe(R(174_100));
    expect(out.monthly.saldoInicial[9]).toBe(out.monthly.saldoFinal[8]);
    expect(out.monthly.saldoFinal[11]).toBe(R(174_100));
    expect(out.monthly.situacao.every((s) => s === "ok")).toBe(true);
  });

  it("Fluxo Mensal: linhas por categoria e subtotais dos 6 grupos de saída", () => {
    const row = (id: string) => out.monthly.rows.find((r) => r.categoryId === id)!;
    expect(row("folha_salarios").months.slice(6, 9)).toEqual([R(48_000), R(48_000), R(49_500)]);
    expect(row("folha_salarios").totalCents).toBe(R(145_500));
    expect(row("prestacao_servicos").totalCents).toBe(R(278_000));
    const grupo = (g: string) => out.monthly.saidasGrupos.find((x) => x.group === g)!;
    expect(grupo("pessoal").totalCents).toBe(R(145_500));
    expect(grupo("operacional").totalCents).toBe(R(31_000 + 12_800 + 44_000));
    expect(grupo("tributos").totalCents).toBe(R(9_400));
    expect(grupo("crescimento").totalCents).toBe(R(4_200));
    expect(grupo("financeiro").totalCents).toBe(0);
    expect(out.monthly.saidasGrupos.map((g) => g.group)).toEqual(["pessoal", "operacional", "tributos", "financeiro", "crescimento", "outras"]);
    expect(out.monthly.rows).toHaveLength(37);
    expect(out.monthly.rows.map((r) => r.categoryId)).not.toContain("transferencia_interna");
  });

  it("Previsto x Realizado: outubro é o único mês previsto; variação = realizado − previsto", () => {
    const entradas = out.variance.lines.find((l) => l.key === "entradas")!;
    const saidas = out.variance.lines.find((l) => l.key === "saidas")!;
    expect(entradas.realizadoAnoCents).toBe(R(226_000));
    expect(entradas.previstoAnoCents).toBe(R(110_000));
    expect(entradas.previsto[9]).toBe(R(110_000));
    expect(entradas.variacao[9]).toBe(R(-110_000));
    expect(saidas.realizadoAnoCents).toBe(R(202_900));
    expect(saidas.previstoAnoCents).toBe(R(44_000));
    const operacional = out.variance.lines.find((l) => l.key === "operacional")!;
    expect(operacional.previsto[9]).toBe(R(44_000));
    expect(operacional.realizado[7]).toBe(R(31_000));
    expect(out.variance.lines.map((l) => l.key)).toEqual(["entradas", "saidas", "pessoal", "operacional", "tributos", "financeiro", "crescimento", "outras"]);
  });

  it("Projeção: médias, saldo de partida e saldo em 12 meses nos três cenários", () => {
    const p = out.projection;
    expect(p.realizedMonths).toBe(3);
    expect(p.realizedMonthsSource).toBe("override");
    expect(p.avgInCents).toBe(R(75_333.33));
    expect(p.avgOutCents).toBe(R(67_633.33));
    expect(p.startingBalanceCents).toBe(R(108_100));
    expect(p.startMonth).toBe("2026-10");
    expect(p.lowConfidence).toBe(false);
    const by = (code: string) => p.scenarios.find((s) => s.code === code)!;
    expect(by("otimista").balance12Cents).toBe(R(336_100));
    expect(by("realista").balance12Cents).toBe(R(200_500));
    expect(by("pessimista").balance12Cents).toBe(R(-20_880));
    expect(by("pessimista").monthsBelowReserve).toBe(8);
    expect(by("pessimista").monthsNegative).toBe(2);
    expect(by("realista").monthsBelowReserve).toBe(0);
    expect(by("otimista").months[0]).toMatchObject({ month: "2026-10", inCents: R(86_633.33), outCents: R(67_633.33), resultCents: R(19_000) });
    expect(by("pessimista").months[0]).toMatchObject({ inCents: R(60_266.67), outCents: R(71_015), resultCents: R(-10_748.33) });
    expect(by("pessimista").months[11].month).toBe("2027-09");
  });

  it("Alertas: caixa negativo no pessimista e concentração da Folha; nada de genérico", () => {
    const codes = out.alerts.map((a) => a.code);
    expect(codes).toContain("negativo_pessimista");
    expect(codes).toContain("concentracao_categoria");
    expect(codes).not.toContain("reserva_realista");
    const neg = out.alerts.find((a) => a.code === "negativo_pessimista")!;
    expect(neg.severity).toBe("critical");
    expect(neg.month).toBe("2027-08");
    expect(neg.text).toContain("ago/2027");
    expect(neg.text).toMatch(/-R\$\s?10\.131,67/);
    const conc = out.alerts.find((a) => a.code === "concentracao_categoria")!;
    expect(conc.categoryId).toBe("folha_salarios");
    expect(conc.text).toContain("58,9%");
    expect(conc.text).toContain("145.500,00");
    expect(conc.text).toContain("246.900,00");
    // Folha: set 49.500 vs média 48.000 = +3,1% → sem alerta de crescimento.
    expect(codes).not.toContain("crescimento_categoria");
  });

  it("o mesmo dataset via unificação de ajustes manuais produz números idênticos", () => {
    const manual: CashflowManualEntry[] = DATASET.map((e, i) => ({
      id: `aj_${i}`,
      companyId: "co_1",
      competenceDate: e.cashDate,
      kind: e.kind,
      categoryId: e.categoryId,
      description: e.description,
      status: e.status,
      amountCents: e.amountCents,
      createdBy: "usr",
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    }));
    const unified = unifyCashflow({
      timeZone: "America/Sao_Paulo",
      payables: [], payments: [], receivables: [], receipts: [], bankAccounts: [], bankTransactions: [], matches: [],
      manualEntries: manual, mappings: [], categories: [...CASHFLOW_CATEGORY_PLAN],
    });
    const again = computeCashflow({ year: YEAR, entries: unified.entries, categories: [...CASHFLOW_CATEGORY_PLAN], parameter: PARAM, scenarios });
    expect(again.monthly.saldoFinal).toEqual(out.monthly.saldoFinal);
    expect(again.projection.scenarios.map((s) => s.balance12Cents)).toEqual(out.projection.scenarios.map((s) => s.balance12Cents));
  });
});

describe("Fluxo de Caixa — regras de borda", () => {
  const cats = [...CASHFLOW_CATEGORY_PLAN];

  it("situação vs reserva: CAIXA NEGATIVO < 0; Abaixo da reserva < reserva; senão OK", () => {
    const m = computeMonthly({
      year: YEAR,
      entries: [entry(1, "aluguel", 30_000, "realizado"), entry(2, "aluguel", 60_000, "realizado"), entry(3, "vendas_produtos", 100_000, "realizado")],
      categories: cats,
      openingBalanceCents: R(50_000),
      minimumReserveCents: R(40_000),
    });
    expect(m.saldoFinal.slice(0, 3)).toEqual([R(20_000), R(-40_000), R(60_000)]);
    expect(m.situacao.slice(0, 3)).toEqual(["abaixo_reserva", "caixa_negativo", "ok"]);
  });

  it("meses realizados = 0: médias zero, aviso, sem divisão; saldo de partida = saldo inicial", () => {
    const p = computeProjection({ year: YEAR, entries: [entry(11, "aluguel", 1_000, "previsto")], openingBalanceCents: R(10_000), minimumReserveCents: R(5_000), scenarios });
    expect(p.realizedMonths).toBe(0);
    expect(p.avgInCents).toBe(0);
    expect(p.avgOutCents).toBe(0);
    expect(p.startingBalanceCents).toBe(R(10_000));
    expect(p.startMonth).toBe("2026-01");
    expect(p.lowConfidence).toBe(true);
    expect(p.warnings[0]).toMatch(/Nenhum mês realizado/);
    expect(p.scenarios.every((s) => s.balance12Cents === R(10_000))).toBe(true);
  });

  it("meses realizados calculados = meses distintos com realizado; override substitui só a contagem", () => {
    const entries = [entry(3, "vendas_produtos", 30_000, "realizado"), entry(3, "aluguel", 10_000, "realizado"), entry(5, "vendas_produtos", 30_000, "realizado")];
    const calc = computeProjection({ year: YEAR, entries, openingBalanceCents: 0, minimumReserveCents: 0, scenarios });
    expect(calc.realizedMonths).toBe(2);
    expect(calc.realizedMonthsSource).toBe("calculado");
    expect(calc.avgInCents).toBe(R(30_000));
    expect(calc.lowConfidence).toBe(true);
    expect(calc.startMonth).toBe("2026-06");
    const over = computeProjection({ year: YEAR, entries, openingBalanceCents: 0, minimumReserveCents: 0, realizedMonthsOverride: 4, scenarios });
    expect(over.realizedMonths).toBe(4);
    expect(over.avgInCents).toBe(R(15_000));
    expect(over.startMonth).toBe("2026-06");
  });

  it("crescimento mensal composto: (1+g)^i por mês, exato", () => {
    const growth: CashflowScenario[] = [{ ...scenarios[1], code: "realista", monthlyGrowthBp: 1000 }];
    const p = computeProjection({ year: YEAR, entries: [entry(1, "vendas_produtos", 1_000, "realizado")], openingBalanceCents: 0, minimumReserveCents: 0, scenarios: growth });
    const m = p.scenarios[0].months;
    expect(m[0].inCents).toBe(R(1_000));
    expect(m[1].inCents).toBe(R(1_100));
    expect(m[2].inCents).toBe(R(1_210));
    expect(m[11].inCents).toBe(R(2_853.12)); // 1000 × 1,1^11 = 2.853,1167…
  });

  it("previsto e realizado somam juntos no Fluxo Mensal, mas ficam separados no Previsto x Realizado", () => {
    const entries = [entry(4, "fornecedores", 1_000, "realizado"), entry(4, "fornecedores", 500, "previsto")];
    const m = computeMonthly({ year: YEAR, entries, categories: cats, openingBalanceCents: 0, minimumReserveCents: 0 });
    expect(m.rows.find((r) => r.categoryId === "fornecedores")!.months[3]).toBe(R(1_500));
    const v = computeVariance({ year: YEAR, entries, categories: cats });
    const op = v.lines.find((l) => l.key === "operacional")!;
    expect([op.realizado[3], op.previsto[3], op.variacao[3]]).toEqual([R(1_000), R(500), R(500)]);
  });

  it("lançamentos de outro ano e a_classificar: fora do ano não entram; não classificados são contados à parte", () => {
    const entries = [entry(2, "a_classificar", 700, "realizado"), { ...entry(2, "aluguel", 100, "realizado"), year: 2025, cashDate: "2025-02-15" }];
    const m = computeMonthly({ year: YEAR, entries, categories: cats, openingBalanceCents: 0, minimumReserveCents: 0 });
    expect(m.saidasAnoCents).toBe(R(700));
    expect(m.naoClassificadosCents).toBe(R(700));
    expect(m.naoClassificadosCount).toBe(1);
  });

  it("alerta de crescimento de categoria acima de 15% cita mês, valor e média anterior", () => {
    const entries = [entry(1, "energia_eletrica", 1_000, "realizado"), entry(2, "energia_eletrica", 1_000, "realizado"), entry(3, "energia_eletrica", 1_300, "realizado")];
    const out = computeCashflow({ year: YEAR, entries, categories: cats, parameter: { openingBalanceCents: R(100_000), minimumReserveCents: 0 }, scenarios });
    const a = out.alerts.find((x) => x.code === "crescimento_categoria")!;
    expect(a.month).toBe("2026-03");
    expect(a.values.growthBp).toBe(3000);
    expect(a.text).toContain("Energia Elétrica");
    expect(a.text).toContain("30,0%");
    expect(a.text).toContain("mar/2026");
  });
});
