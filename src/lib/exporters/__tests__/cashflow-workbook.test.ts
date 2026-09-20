/**
 * Pasta "Fluxo de Caixa CETEM": as 7 abas, as fórmulas da planilha original
 * nas MESMAS posições (grade de 37 categorias) e os valores em cache iguais
 * ao cálculo do app — e a ida e volta pelo leitor .xlsx.
 */
import { describe, expect, it } from "vitest";
import type { CashflowEntry, CashflowScenario } from "@/core/entities";
import { CASHFLOW_SCENARIO_SEED, computeCashflow, seedCashflowCategories } from "@/core/cashflow";
import { readXlsx } from "@/lib/importers/xlsx-reader";
import { LANC_SPARE_ROWS, SHEET, buildCashflowWorkbook, buildCashflowWorkbookSpec, type CashflowWorkbookInput } from "../cashflow-workbook";
import { centsToDecimal, excelDateSerial } from "../xlsx";

const YEAR = 2026;
const NOW = "2026-09-18T15:00:00.000Z";
const R = (reais: number) => Math.round(reais * 100);
const categories = seedCashflowCategories();
const idOf = (name: string) => categories.find((c) => c.name === name)!.id;
const catById = new Map(categories.map((c) => [c.id, c]));

function entry(month: number, name: string, amountReais: number, status: CashflowEntry["status"], over: Partial<CashflowEntry> = {}): CashflowEntry {
  const cat = catById.get(idOf(name))!;
  const cashDate = `${YEAR}-${String(month).padStart(2, "0")}-15`;
  return {
    competenceDate: cashDate,
    cashDate,
    kind: cat.kind === "entrada" ? "entrada" : "saida",
    categoryId: cat.id,
    group: cat.group,
    description: `${name} ${month}`,
    status,
    realizedBy: status === "realizado" ? "baixa_app" : undefined,
    amountCents: R(amountReais),
    origin: "contas_pagar",
    originId: `${cat.id}-${month}-${status}`,
    month,
    year: YEAR,
    ...over,
  };
}

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

const ENTRIES: CashflowEntry[] = [
  entry(7, "Prestação de Serviços", 92_000, "realizado", { origin: "contas_receber", costCenterId: "cc_eng" }),
  entry(7, "Folha e Salários", 48_000, "realizado"),
  entry(7, "Simples Nacional / DAS", 9_400, "realizado", { origin: "conciliacao", realizedBy: "conciliacao" }),
  entry(7, "Aluguel", 6_000, "realizado"),
  entry(8, "Vendas de Produtos", 50_000, "realizado", { origin: "contas_receber" }),
  entry(8, "Folha e Salários", 48_000, "realizado"),
  entry(8, "Energia Elétrica", 1_200, "realizado"),
  entry(8, "A Classificar", 500, "realizado"),
  entry(9, "Prestação de Serviços", 60_000, "realizado", { origin: "ajuste_manual", originId: "fca_1", description: "Ajuste & <teste>" }),
  entry(9, "Folha e Salários", 48_000, "realizado"),
  entry(9, "Marketing e Publicidade", 3_000, "realizado"),
  entry(10, "Prestação de Serviços", 70_000, "previsto", { origin: "contas_receber" }),
  entry(10, "Folha e Salários", 48_000, "previsto"),
];

function inputFor(entries: CashflowEntry[]): CashflowWorkbookInput {
  const parameter = { openingBalanceCents: R(85_000), minimumReserveCents: R(60_000), realizedMonthsOverride: 3, configured: true };
  const out = computeCashflow({ year: YEAR, entries, categories, parameter, scenarios });
  return {
    year: YEAR,
    generatedAt: NOW,
    timeZone: "America/Sao_Paulo",
    companyName: "Café Aurora Ltda",
    generatedBy: "Ana Prado <ana@cafeaurora.com.br>",
    categories,
    costCenters: [
      { id: "cc_adm", code: "CC-01", name: "Administrativo" },
      { id: "cc_eng", code: "CC-02", name: "Engenharia" },
    ],
    parameter,
    scenarios: scenarios.map((s) => ({ code: s.code, name: s.name, revenueAdjustmentBp: s.revenueAdjustmentBp, expenseAdjustmentBp: s.expenseAdjustmentBp, monthlyGrowthBp: s.monthlyGrowthBp })),
    entries,
    monthly: out.monthly,
    variance: out.variance,
    projection: out.projection,
    alerts: out.alerts,
  };
}

const input = inputFor(ENTRIES);
const spec = buildCashflowWorkbookSpec(input);
const cellsOf = (name: string) => spec.sheets.find((s) => s.name === name)!.cells;
const LAST = ENTRIES.length + 1 + LANC_SPARE_ROWS;
const L = (col: string) => `Lançamentos!$${col}$2:$${col}$${LAST}`;

describe("buildCashflowWorkbookSpec — estrutura da planilha", () => {
  it("tem as 7 abas na ordem da planilha original e os 4 nomes definidos das listas", () => {
    expect(spec.sheets.map((s) => s.name)).toEqual(["Instruções", "Parâmetros", "Lançamentos", "Fluxo Mensal", "Previsto x Realizado", "Projeção", "Dashboard"]);
    expect(spec.definedNames).toEqual([
      { name: "lista_categorias", ref: "Parâmetros!$B$18:$B$54" },
      { name: "lista_centros", ref: "Parâmetros!$G$5:$G$6" },
      { name: "lista_status", ref: "Parâmetros!$I$9:$I$10" },
      { name: "lista_tipo", ref: "Parâmetros!$I$5:$I$6" },
    ]);
  });

  it("Instruções: data/origem, empresa, ano base, gerado por, sem linhas de exemplo e com a regra de reimportação", () => {
    const c = cellsOf(SHEET.instrucoes);
    expect(c.B2.v).toBe("FLUXO DE CAIXA — CETEM");
    expect(c.B4.v).toBe("Gerado em");
    expect(String(c.C4.v)).toMatch(/18\/09\/2026,? 12:00 \(America\/Sao_Paulo\)/);
    expect(c.C5.v).toBe("Café Aurora Ltda");
    expect(c.C6.v).toBe("2026");
    expect(c.C7.v).toBe("Ana Prado <ana@cafeaurora.com.br>");
    const textos = Object.values(c).map((x) => String(x.v ?? ""));
    expect(textos.some((t) => t.startsWith("Financeira PME — títulos a pagar"))).toBe(true);
    expect(textos.some((t) => t.includes("13 linha(s) reais, sem dados de exemplo"))).toBe(true);
    expect(textos.some((t) => t.includes("Só linhas NOVAS (Origem em branco) viram ajustes manuais"))).toBe(true);
    expect(textos.some((t) => t.includes(`até a linha ${LAST}`))).toBe(true);
    expect(textos.some((t) => /EXEMPLO/.test(t))).toBe(false);
  });

  it("Parâmetros: premissas nas células da planilha (C4..C7), cenários em C11:E13 como fração exata, plano B18:E54, listas G/I", () => {
    const c = cellsOf(SHEET.parametros);
    expect(c.C4.v).toBe(2026);
    expect(c.C5.money).toBe(R(85_000));
    expect(c.C6.money).toBe(R(60_000));
    expect(c.C7.v).toBe(3);
    expect(c.C5.style?.fill).toBe("FFF2CC");
    expect([c.B11.v, c.C11.num, c.D11.num, c.E11.num]).toEqual(["Otimista", "0.1500", "0.0000", "0.0000"]);
    expect([c.B13.v, c.C13.num, c.D13.num]).toEqual(["Pessimista", "-0.2000", "0.0500"]);
    expect(c.B17.v).toBe("Categoria");
    expect(c.B18.v).toBe("Vendas de Produtos");
    expect([c.C18.v, c.D18.v, c.E18.v]).toEqual(["Entrada", "Receita Operacional", "Variável"]);
    expect(c.B54.v).toBe("A Classificar");
    expect(c.B55).toBeUndefined();
    expect([c.G5.v, c.G6.v]).toEqual(["Administrativo", "Engenharia"]);
    expect([c.I5.v, c.I6.v, c.I9.v, c.I10.v]).toEqual(["Entrada", "Saída", "Realizado", "Previsto"]);
  });

  it("Lançamentos: uma linha por evento (ordenada por data), coluna Origem/Referência, fórmulas auxiliares, validações e linhas livres", () => {
    const sheet = spec.sheets.find((s) => s.name === SHEET.lancamentos)!;
    const c = sheet.cells;
    expect(["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1", "J1", "K1", "L1", "M1", "N1"].map((r) => c[r].v)).toEqual([
      "Data", "Tipo", "Categoria", "Descrição", "Centro de Custo", "Status", "Valor", "Grupo", "Mês", "Ano", "Origem", "Referência", "Apuração do realizado", "Competência",
    ]);
    // 1ª linha de dados = 1ª entrada de julho (entrada antes de saída na mesma data).
    expect(c.A2.v).toBe(excelDateSerial("2026-07-15"));
    expect(c.A2.style?.numFmt).toBe("date");
    expect([c.B2.v, c.C2.v, c.E2.v, c.F2.v, c.G2.money, c.K2.v, c.L2.v, c.M2.v]).toEqual([
      "Entrada", "Prestação de Serviços", "Engenharia", "Realizado", R(92_000), "Contas a receber", "prestacao_servicos-7-realizado", "Baixa no app",
    ]);
    expect(c.H2.f).toBe('IF($C2="","",IFERROR(INDEX(Parâmetros!$D$18:$D$54,MATCH($C2,lista_categorias,0)),"Categoria inválida"))');
    expect(c.H2.cached).toBe("Receita Operacional");
    expect(c.I2).toMatchObject({ f: 'IF($A2="","",MONTH($A2))', cached: 7 });
    expect(c.J2).toMatchObject({ f: 'IF($A2="","",YEAR($A2))', cached: 2026 });
    // Conciliação aparece como tal; previsto não tem apuração.
    const dasRow = Object.entries(c).find(([ref, cell]) => /^C\d+$/.test(ref) && cell.v === "Simples Nacional / DAS")![0].slice(1);
    expect([c[`K${dasRow}`].v, c[`M${dasRow}`].v]).toEqual(["Conciliação bancária", "Conciliação bancária"]);
    const previstoRow = Object.entries(c).find(([ref, cell]) => /^F\d+$/.test(ref) && cell.v === "Previsto")![0].slice(1);
    expect(c[`M${previstoRow}`]).toBeUndefined();
    // 13 linhas de dados, depois linhas livres com fórmulas sem cache.
    const dataRows = Object.keys(c).filter((ref) => /^A\d+$/.test(ref) && c[ref].v !== undefined && ref !== "A1");
    expect(dataRows).toHaveLength(ENTRIES.length);
    expect(c[`I${LAST}`]).toEqual({ f: `IF($A${LAST}="","",MONTH($A${LAST}))`, cached: undefined });
    expect(c[`I${LAST + 1}`]).toBeUndefined();
    expect(sheet.freeze).toBe("A2");
    expect(sheet.validations).toEqual([
      { sqref: `B2:B${LAST}`, list: "lista_tipo" },
      { sqref: `C2:C${LAST}`, list: "lista_categorias" },
      { sqref: `E2:E${LAST}`, list: "lista_centros" },
      { sqref: `F2:F${LAST}`, list: "lista_status" },
    ]);
    expect(Object.values(c).some((cell) => /EXEMPLO/.test(String(cell.v ?? "")))).toBe(false);
  });

  it("Fluxo Mensal: mesmas linhas da planilha (9-12 entradas, 13 total, subtotais 21/30/38/43/48/54, 55/57/58/59) com SUMIFS e cache do app", () => {
    const c = cellsOf(SHEET.mensal);
    const { monthly } = input;
    expect(c.C3).toMatchObject({ f: "Parâmetros!$C$4", cached: 2026 });
    expect(c.C4.v).toBe(1);
    expect(c.N4.v).toBe(12);
    expect([c.C5.v, c.N5.v, c.O5.v]).toEqual(["Jan", "Dez", "Total do Ano"]);
    expect(c.C6).toMatchObject({ f: "Parâmetros!$C$5", cached: "85000.00" });
    expect(c.D6).toMatchObject({ f: "C58", cached: centsToDecimal(monthly.saldoInicial[1]) });
    expect(c.B9.v).toBe("Vendas de Produtos");
    expect(c.C9.f).toBe(`SUMIFS(${L("G")},${L("C")},$B9,${L("I")},C$4,${L("J")},$C$3)`);
    expect(c.O9.f).toBe("SUM(C9:N9)");
    expect(c.B13.v).toBe("TOTAL DE ENTRADAS");
    expect(c.C13.f).toBe("SUM(C9:C12)");
    expect(c.I13.cached).toBe(centsToDecimal(monthly.entradasTotal[6])); // I = julho
    expect(c.O13.cached).toBe(centsToDecimal(monthly.entradasAnoCents));
    expect(c.B16.v).toBe("Folha e Salários");
    expect(c.I16.cached).toBe(centsToDecimal(R(48_000)));
    expect([c.B21.v, c.C21.f]).toEqual(["Subtotal Pessoal", "SUM(C16:C20)"]);
    expect([c.B30.v, c.C30.f]).toEqual(["Subtotal Operacional", "SUM(C22:C29)"]);
    expect([c.B38.v, c.C38.f]).toEqual(["Subtotal Tributos", "SUM(C31:C37)"]);
    expect([c.B43.v, c.C43.f]).toEqual(["Subtotal Financeiro", "SUM(C39:C42)"]);
    expect([c.B48.v, c.C48.f]).toEqual(["Subtotal Crescimento", "SUM(C44:C47)"]);
    expect([c.B53.v, c.B54.v, c.C54.f]).toEqual(["A Classificar", "Subtotal Outras", "SUM(C49:C53)"]);
    // A Classificar (saída) só soma linhas de Saída — uma entrada sem de-para não vira despesa.
    expect(c.C53.f).toBe(`SUMIFS(${L("G")},${L("C")},"A Classificar",${L("I")},C$4,${L("J")},$C$3,${L("B")},"Saída")`);
    expect(c.J53.cached).toBe(centsToDecimal(R(500))); // J = agosto
    expect([c.B55.v, c.C55.f]).toEqual(["TOTAL DE SAÍDAS", "C21+C30+C38+C43+C48+C54"]);
    expect(c.O55.cached).toBe(centsToDecimal(monthly.saidasAnoCents));
    expect([c.B57.v, c.C57.f, c.O57.f]).toEqual(["RESULTADO DO MÊS (Entradas − Saídas)", "C13-C55", "O13-O55"]);
    expect([c.B58.v, c.C58.f, c.D58.f, c.O58.f]).toEqual(["SALDO FINAL DE CAIXA", "C6+C57", "D6+D57", "N58"]);
    expect(c.N58.cached).toBe(centsToDecimal(monthly.saldoFinal[11]));
    expect(c.C59.f).toBe('IF(C58<0,"CAIXA NEGATIVO",IF(C58<Parâmetros!$C$6,"Abaixo da reserva","OK"))');
    expect(c.C59.cached).toBe("OK");
    expect(c.B60).toBeUndefined();
  });

  it("Previsto x Realizado: blocos de 3 linhas por total/grupo com SUMIFS por Tipo/Status/Grupo e cache da variação", () => {
    const c = cellsOf(SHEET.previstoRealizado);
    const { variance } = input;
    expect([c.B5.v, c.C5.v, c.D5.v, c.O5.v, c.P5.v]).toEqual(["Linha", "Visão", "Jan", "Dez", "Total"]);
    expect([c.B6.v, c.C6.v, c.C7.v, c.C8.v]).toEqual(["TOTAL DE ENTRADAS", "Previsto", "Realizado", "Variação"]);
    expect(c.D6.f).toBe(`SUMIFS(${L("G")},${L("B")},"Entrada",${L("F")},"Previsto",${L("I")},D$4,${L("J")},$C$3)`);
    expect(c.D7.f).toContain('"Realizado"');
    expect(c.D8.f).toBe("D7-D6");
    expect(c.P6.f).toBe("SUM(D6:O6)");
    expect([c.B10.v, c.D10.f]).toEqual(["TOTAL DE SAÍDAS", `SUMIFS(${L("G")},${L("B")},"Saída",${L("F")},"Previsto",${L("I")},D$4,${L("J")},$C$3)`]);
    expect(c.B14.v).toBe("Saídas — Pessoal");
    expect(c.D14.f).toBe(`SUMIFS(${L("G")},${L("H")},"Pessoal",${L("B")},"Saída",${L("F")},"Previsto",${L("I")},D$4,${L("J")},$C$3)`);
    const entradas = variance.lines.find((l) => l.key === "entradas")!;
    expect(c.J7.cached).toBe(centsToDecimal(entradas.realizado[6]));
    expect(c.M6.cached).toBe(centsToDecimal(entradas.previsto[9]));
    expect(c.P8.cached).toBe(centsToDecimal(entradas.variacaoAnoCents));
    expect(c.B34.v).toBe("Saídas — Outras");
  });

  it("Projeção: médias, ponto de partida, três cenários com potência de crescimento, COUNTIF e cache exato", () => {
    const c = cellsOf(SHEET.projecao);
    const { projection } = input;
    expect(c.C3).toMatchObject({ f: "Parâmetros!$C$7", cached: 3 });
    expect(c.C4.f).toBe(`SUMIFS(${L("G")},${L("B")},"Entrada",${L("F")},"Realizado",${L("J")},Parâmetros!$C$4)`);
    expect(c.C4.cached).toBe(centsToDecimal(projection.realizedInCents));
    expect(c.C6).toMatchObject({ f: "IFERROR($C$4/$C$3,0)", cached: centsToDecimal(projection.avgInCents) });
    expect(c.C8).toMatchObject({ f: "Parâmetros!$C$5+$C$4-$C$5", cached: centsToDecimal(projection.startingBalanceCents) });
    expect(c.C9.f).toBe("Parâmetros!$C$6");
    expect([c.C12.v, c.N12.v]).toEqual(["M+1", "M+12"]);
    expect(c.C11.v).toBe("out/2026");
    expect(c.B13.v).toBe("CENÁRIO OTIMISTA");
    expect(c.C14.f).toBe("$C$6*(1+Parâmetros!$C$11)*(1+Parâmetros!$E$11)^0");
    expect(c.D14.f).toBe("$C$6*(1+Parâmetros!$C$11)*(1+Parâmetros!$E$11)^1");
    expect(c.N15.f).toBe("$C$7*(1+Parâmetros!$D$11)*(1+Parâmetros!$E$11)^11");
    expect(c.C16.f).toBe("C14-C15");
    expect([c.C17.f, c.D17.f, c.N17.f]).toEqual(["$C$8+C16", "C17+D16", "M17+N16"]);
    expect(c.C18.f).toBe('COUNTIF(C17:N17,"<"&$C$9)');
    expect(c.F18.f).toBe('COUNTIF(C17:N17,"<0")');
    expect(c.I18.f).toBe("N17");
    expect(c.B20.v).toBe("CENÁRIO REALISTA");
    expect(c.B27.v).toBe("CENÁRIO PESSIMISTA");
    expect(c.C28.f).toBe("$C$6*(1+Parâmetros!$C$13)*(1+Parâmetros!$E$13)^0");
    const pess = projection.scenarios.find((s) => s.code === "pessimista")!;
    expect(c.N31.cached).toBe(centsToDecimal(pess.months[11].balanceCents));
    expect(c.C32.cached).toBe(pess.monthsBelowReserve);
    expect(c.I32.cached).toBe(centsToDecimal(pess.balance12Cents));
  });

  it("Dashboard: KPIs apontam para as células certas do Fluxo Mensal e da Projeção; aviso de A Classificar; série mensal e grupos", () => {
    const c = cellsOf(SHEET.dashboard);
    expect(c.B3.f).toContain(`COUNTIFS(${L("C")},"A Classificar",${L("J")},Parâmetros!$C$4)>0`);
    expect(c.B3.cached).toBe("ATENÇÃO: 1 lançamento(s) do ano base em A Classificar. Classifique-os no app (Lançamentos → fila A classificar).");
    expect([c.B6.f, c.D6.f, c.F6.f, c.H6.f]).toEqual(["'Fluxo Mensal'!O13", "'Fluxo Mensal'!O55", "'Fluxo Mensal'!O57", "'Fluxo Mensal'!N58"]);
    expect(c.B6.cached).toBe(centsToDecimal(input.monthly.entradasAnoCents));
    expect([c.B9.f, c.D9.f, c.F9.f, c.H9.f]).toEqual(["Projeção!N17", "Projeção!N24", "Projeção!N31", "Projeção!C32"]);
    expect(c.B13.v).toBe("jan/2026");
    expect([c.C13.f, c.F24.f, c.G24.f]).toEqual(["'Fluxo Mensal'!C13", "'Fluxo Mensal'!N58", "'Fluxo Mensal'!N59"]);
    const pessoal = Object.entries(c).find(([ref, cell]) => /^B\d+$/.test(ref) && cell.v === "Pessoal")![0].slice(1);
    expect(c[`C${pessoal}`].f).toBe("'Fluxo Mensal'!O21");
    expect(c[`D${pessoal}`].f).toBe(`IFERROR(C${pessoal}/$D$6,0)`);
    expect(Object.values(c).some((cell) => String(cell.v ?? "").includes("Alertas do app"))).toBe(true);
  });

  it("entrada sem de-para vira a linha 'A Classificar (entradas)' no bloco de entradas e desloca a grade em uma linha", () => {
    const withIn = inputFor([...ENTRIES, entry(8, "A Classificar", 700, "realizado", { kind: "entrada", origin: "contas_receber", originId: "rv_x" })]);
    const c = buildCashflowWorkbookSpec(withIn).sheets.find((s) => s.name === SHEET.mensal)!.cells;
    expect(c.B13.v).toBe("A Classificar (entradas)");
    const last = withIn.entries.length + 1 + LANC_SPARE_ROWS;
    expect(c.C13.f).toBe(`SUMIFS(Lançamentos!$G$2:$G$${last},Lançamentos!$C$2:$C$${last},"A Classificar",Lançamentos!$I$2:$I$${last},C$4,Lançamentos!$J$2:$J$${last},$C$3,Lançamentos!$B$2:$B$${last},"Entrada")`);
    expect(c.J13.cached).toBe(centsToDecimal(R(700)));
    expect([c.B14.v, c.C14.f]).toEqual(["TOTAL DE ENTRADAS", "SUM(C9:C13)"]);
    expect([c.B56.v, c.C56.f]).toEqual(["TOTAL DE SAÍDAS", "C22+C31+C39+C44+C49+C55"]);
    const dash = buildCashflowWorkbookSpec(withIn).sheets.find((s) => s.name === SHEET.dashboard)!.cells;
    expect([dash.B6.f, dash.D6.f, dash.H6.f]).toEqual(["'Fluxo Mensal'!O14", "'Fluxo Mensal'!O56", "'Fluxo Mensal'!N59"]);
  });
});

describe("buildCashflowWorkbook — bytes", () => {
  it("gera um .xlsx que o leitor próprio abre com as 7 abas, valores em cache numéricos e textos íntegros", () => {
    const bytes = buildCashflowWorkbook(input);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    const wb = readXlsx(bytes);
    expect(wb.sheetNames).toEqual(Object.values(SHEET));
    const lanc = wb.readSheet(SHEET.lancamentos)!;
    expect(lanc.cells.get("C2")).toEqual({ type: "s", value: "Prestação de Serviços" });
    expect(lanc.cells.get("G2")).toEqual({ type: "n", value: 92000 });
    expect(lanc.cells.get("D10")).toEqual({ type: "s", value: "Ajuste & <teste>" });
    expect(lanc.cells.get("H2")).toEqual({ type: "s", value: "Receita Operacional" });
    const fm = wb.readSheet(SHEET.mensal)!;
    expect(fm.cells.get("I13")).toEqual({ type: "n", value: input.monthly.entradasTotal[6] / 100 });
    expect(fm.cells.get("C59")).toEqual({ type: "s", value: "OK" });
    const xml = Buffer.from(bytes).toString("latin1");
    expect(xml).toContain('<definedName name="lista_categorias">Parâmetros!$B$18:$B$54</definedName>'.replace(/[^\x00-\x7f]/g, (ch) => Buffer.from(ch, "utf8").toString("latin1")));
    expect(xml).toContain('fullCalcOnLoad="1"');
    expect(xml).toContain('<pane xSplit="2" ySplit="5" topLeftCell="C6" activePane="bottomRight" state="frozen"/>');
    expect(xml).toContain('<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="C2:C214"><formula1>lista_categorias</formula1></dataValidation>');
    expect(xml).not.toContain("EXEMPLO");
  });
});
