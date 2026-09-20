/**
 * Pasta de trabalho "Fluxo de Caixa CETEM" — as 7 abas da planilha original
 * (Instruções, Parâmetros, Lançamentos, Fluxo Mensal, Previsto x Realizado,
 * Projeção, Dashboard) geradas a partir dos dados REAIS do app, com as mesmas
 * fórmulas vivas (SUMIFS por categoria/mês/ano, SUM, encadeamento de saldo,
 * COUNTIF) apontando para a aba Lançamentos, como na planilha.
 *
 * Toda célula de fórmula leva também o valor calculado pelo app (cache), então
 * o arquivo mostra os números certos mesmo em visualizadores que não
 * recalculam; ao abrir no Excel, tudo é recalculado (fullCalcOnLoad).
 *
 * A aba Lançamentos tem uma linha por evento de caixa unificado, com a coluna
 * Origem (Contas a pagar / Contas a receber / Conciliação bancária / Ajuste
 * manual) e a Referência do registro original — sem nenhuma linha de exemplo.
 * Função pura: recebe o que o app já calculou e devolve a especificação da
 * pasta (e os bytes). Sem macros.
 */

import type { CashflowCategory, CashflowEntry, CashflowScenarioCode } from "@/core/entities";
import {
  CASHFLOW_EXPENSE_GROUPS,
  CASHFLOW_GROUP_LABEL,
  CASHFLOW_UNCLASSIFIED_ID,
  CASH_SITUATION_LABEL,
  monthLabel,
  type CashflowAlert,
  type MonthlyRow,
  type MonthlyStatement,
  type ProjectionResult,
  type VarianceStatement,
} from "@/core/cashflow";
import {
  buildXlsxWorkbook,
  centsToDecimal,
  columnLetter,
  excelDateSerial,
  type XlsxCell,
  type XlsxGridSheet,
  type XlsxStyle,
  type XlsxWorkbookSpec,
} from "./xlsx";

export const SHEET = {
  instrucoes: "Instruções",
  parametros: "Parâmetros",
  lancamentos: "Lançamentos",
  mensal: "Fluxo Mensal",
  previstoRealizado: "Previsto x Realizado",
  projecao: "Projeção",
  dashboard: "Dashboard",
} as const;

/** Colunas da aba Lançamentos — a importação lê as mesmas (pelo cabeçalho). */
export const LANC_COL = {
  data: "A",
  tipo: "B",
  categoria: "C",
  descricao: "D",
  centro: "E",
  status: "F",
  valor: "G",
  grupo: "H",
  mes: "I",
  ano: "J",
  origem: "K",
  referencia: "L",
  apuracao: "M",
  competencia: "N",
} as const;

export const LANC_HEADER: Record<keyof typeof LANC_COL, string> = {
  data: "Data",
  tipo: "Tipo",
  categoria: "Categoria",
  descricao: "Descrição",
  centro: "Centro de Custo",
  status: "Status",
  valor: "Valor",
  grupo: "Grupo",
  mes: "Mês",
  ano: "Ano",
  origem: "Origem",
  referencia: "Referência",
  apuracao: "Apuração do realizado",
  competencia: "Competência",
};

export const TIPO_PLANILHA: Record<CashflowEntry["kind"], string> = { entrada: "Entrada", saida: "Saída" };
export const STATUS_PLANILHA: Record<CashflowEntry["status"], string> = { previsto: "Previsto", realizado: "Realizado" };
export const ORIGEM_PLANILHA: Record<CashflowEntry["origin"], string> = {
  contas_pagar: "Contas a pagar",
  contas_receber: "Contas a receber",
  conciliacao: "Conciliação bancária",
  ajuste_manual: "Ajuste manual",
};
const APURACAO_PLANILHA: Record<string, string> = { conciliacao: "Conciliação bancária", baixa_app: "Baixa no app" };

/** Linhas livres (com fórmulas e validação) depois dos dados, para digitação. */
export const LANC_SPARE_ROWS = 200;

export interface CashflowWorkbookInput {
  year: number;
  /** Instante do cálculo (ISO). */
  generatedAt: string;
  timeZone: string;
  companyName: string;
  generatedBy: string;
  categories: CashflowCategory[];
  costCenters: Array<{ id: string; code: string; name: string }>;
  parameter: { openingBalanceCents: number; minimumReserveCents: number; realizedMonthsOverride?: number; configured: boolean };
  scenarios: Array<{ code: CashflowScenarioCode; name: string; revenueAdjustmentBp: number; expenseAdjustmentBp: number; monthlyGrowthBp: number }>;
  entries: CashflowEntry[];
  monthly: MonthlyStatement;
  variance: VarianceStatement;
  projection: ProjectionResult;
  alerts: CashflowAlert[];
}

// ---------------------------------------------------------------------------
// Estilos (cores da planilha original)
// ---------------------------------------------------------------------------

const NAVY = "1F3864";
const BLUE = "2F5597";
const LIGHT = "D9E2F3";
const MID = "BDD7EE";
const GRAY = "F2F2F2";
const GREEN_BG = "E2EFDA";
const RED_BG = "FCE4E4";
const YELLOW = "FFF2CC";
const INPUT = "0000FF";
const LINK = "008000";

const S = {
  title: { bold: true, color: "FFFFFF", fill: NAVY } as XlsxStyle,
  header: { bold: true, color: "FFFFFF", fill: BLUE } as XlsxStyle,
  section: { bold: true, color: NAVY, fill: LIGHT } as XlsxStyle,
  label: { bold: true } as XlsxStyle,
  muted: { color: "595959" } as XlsxStyle,
  mutedWrap: { color: "595959", wrap: true } as XlsxStyle,
  wrap: { wrap: true } as XlsxStyle,
  monthNo: { color: "A6A6A6" } as XlsxStyle,
  input: { color: INPUT } as XlsxStyle,
  inputDate: { color: INPUT, numFmt: "date" } as XlsxStyle,
  inputMoney: { color: INPUT, numFmt: "brl" } as XlsxStyle,
  premiseMoney: { color: INPUT, numFmt: "brl", fill: YELLOW } as XlsxStyle,
  premiseInt: { color: INPUT, numFmt: "int", fill: YELLOW } as XlsxStyle,
  premisePct: { color: INPUT, numFmt: "percent1", fill: YELLOW } as XlsxStyle,
  link: { color: LINK } as XlsxStyle,
  linkMoney: { color: LINK, numFmt: "brl" } as XlsxStyle,
  linkInt: { color: LINK, numFmt: "int" } as XlsxStyle,
  money: { numFmt: "brl" } as XlsxStyle,
  moneyBold: { bold: true, numFmt: "brl" } as XlsxStyle,
  subtotal: { bold: true, fill: LIGHT, numFmt: "brl" } as XlsxStyle,
  subtotalLabel: { bold: true, fill: LIGHT } as XlsxStyle,
  total: { bold: true, fill: MID, numFmt: "brl" } as XlsxStyle,
  totalLabel: { bold: true, fill: MID } as XlsxStyle,
  band: { bold: true, fill: GRAY, numFmt: "brl" } as XlsxStyle,
  bandLabel: { bold: true, fill: GRAY } as XlsxStyle,
  bandPlain: { fill: GRAY, numFmt: "brl" } as XlsxStyle,
  kpi: { bold: true, color: NAVY, fill: GRAY, numFmt: "brl" } as XlsxStyle,
  kpiInt: { bold: true, color: NAVY, fill: RED_BG, numFmt: "int" } as XlsxStyle,
  date: { numFmt: "date" } as XlsxStyle,
  pct: { numFmt: "percent1" } as XlsxStyle,
};

type Cells = Record<string, XlsxCell>;
const txt = (v: string, style?: XlsxStyle): XlsxCell => ({ v, style });
const num = (n: number, style?: XlsxStyle): XlsxCell => ({ v: n, style });
const money = (cents: number, style?: XlsxStyle): XlsxCell => ({ money: cents, style: style ?? S.money });
const fx = (f: string, cached?: number | string, style?: XlsxStyle): XlsxCell => ({ f, cached, style });
const cash = (cents: number): string => centsToDecimal(cents);
/** Pontos-base → literal decimal exato ("0.1500"). */
const bpToDecimal = (bp: number): string => {
  const sign = bp < 0 ? "-" : "";
  const abs = Math.abs(bp);
  return `${sign}${Math.floor(abs / 10_000)}.${String(abs % 10_000).padStart(4, "0")}`;
};

const P = `${SHEET.parametros}!`;
const FM = `'${SHEET.mensal}'!`;
const PJ = `${SHEET.projecao}!`;
const LS = `${SHEET.lancamentos}!`;

// ---------------------------------------------------------------------------
// Aba Lançamentos
// ---------------------------------------------------------------------------

interface LancamentosLayout {
  sheet: XlsxGridSheet;
  /** Última linha coberta pelas fórmulas (dados + linhas livres). */
  lastRow: number;
  /** Faixa absoluta de uma coluna: "Lançamentos!$G$2:$G$999". */
  range: (col: string) => string;
}

function sortEntries(entries: CashflowEntry[]): CashflowEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.cashDate.localeCompare(b.cashDate) ||
      a.kind.localeCompare(b.kind) ||
      a.origin.localeCompare(b.origin) ||
      a.originId.localeCompare(b.originId)
  );
}

function buildLancamentos(input: CashflowWorkbookInput, planEndRow: number): LancamentosLayout {
  const entries = sortEntries(input.entries);
  const lastRow = entries.length + 1 + LANC_SPARE_ROWS;
  const range = (col: string) => `${LS}$${col}$2:$${col}$${lastRow}`;
  const catName = new Map(input.categories.map((c) => [c.id, c.name]));
  const ccName = new Map(input.costCenters.map((c) => [c.id, c.name]));
  const cells: Cells = {};

  (Object.keys(LANC_COL) as Array<keyof typeof LANC_COL>).forEach((key) => {
    cells[`${LANC_COL[key]}1`] = txt(LANC_HEADER[key], S.header);
  });

  const grupoFormula = (r: number) =>
    `IF($C${r}="","",IFERROR(INDEX(${P}$D$18:$D$${planEndRow},MATCH($C${r},lista_categorias,0)),"Categoria inválida"))`;

  entries.forEach((e, i) => {
    const r = i + 2;
    cells[`A${r}`] = num(excelDateSerial(e.cashDate), S.inputDate);
    cells[`B${r}`] = txt(TIPO_PLANILHA[e.kind], S.input);
    cells[`C${r}`] = txt(catName.get(e.categoryId) ?? e.categoryId, S.input);
    cells[`D${r}`] = txt(e.description, S.input);
    if (e.costCenterId) cells[`E${r}`] = txt(ccName.get(e.costCenterId) ?? e.costCenterId, S.input);
    cells[`F${r}`] = txt(STATUS_PLANILHA[e.status], S.input);
    cells[`G${r}`] = money(e.amountCents, S.inputMoney);
    cells[`H${r}`] = fx(grupoFormula(r), CASHFLOW_GROUP_LABEL[e.group], S.link);
    cells[`I${r}`] = fx(`IF($A${r}="","",MONTH($A${r}))`, e.month);
    cells[`J${r}`] = fx(`IF($A${r}="","",YEAR($A${r}))`, e.year);
    cells[`K${r}`] = txt(ORIGEM_PLANILHA[e.origin]);
    cells[`L${r}`] = txt(e.originId);
    if (e.status === "realizado") cells[`M${r}`] = txt(APURACAO_PLANILHA[e.realizedBy ?? ""] ?? "");
    cells[`N${r}`] = num(excelDateSerial(e.competenceDate), S.date);
  });
  // Linhas livres: fórmulas auxiliares e formatos prontos para digitação.
  for (let r = entries.length + 2; r <= lastRow; r++) {
    cells[`A${r}`] = { style: S.inputDate };
    cells[`G${r}`] = { style: S.inputMoney };
    cells[`H${r}`] = fx(grupoFormula(r), undefined, S.link);
    cells[`I${r}`] = fx(`IF($A${r}="","",MONTH($A${r}))`);
    cells[`J${r}`] = fx(`IF($A${r}="","",YEAR($A${r}))`);
  }

  const sheet: XlsxGridSheet = {
    name: SHEET.lancamentos,
    cells,
    freeze: "A2",
    colWidths: { A: 12, B: 10, C: 28, D: 48, E: 24, F: 11, G: 16, H: 24, I: 6, J: 7, K: 22, L: 28, M: 22, N: 13 },
    validations: [
      { sqref: `B2:B${lastRow}`, list: "lista_tipo" },
      { sqref: `C2:C${lastRow}`, list: "lista_categorias" },
      { sqref: `E2:E${lastRow}`, list: "lista_centros" },
      { sqref: `F2:F${lastRow}`, list: "lista_status" },
    ],
  };
  return { sheet, lastRow, range };
}

// ---------------------------------------------------------------------------
// Aba Parâmetros
// ---------------------------------------------------------------------------

interface ParametrosLayout {
  sheet: XlsxGridSheet;
  planStartRow: number;
  planEndRow: number;
  centrosEndRow: number;
  /** Linha do cenário na tabela (11 = 1º cenário). */
  scenarioRow: (code: CashflowScenarioCode) => number | undefined;
}

const PLAN_START_ROW = 18;
const SCENARIO_FIRST_ROW = 11;

function buildParametros(input: CashflowWorkbookInput, realizedMonths: number): ParametrosLayout {
  const cells: Cells = {};
  const plan = [...input.categories].filter((c) => c.kind !== "neutro").sort((a, b) => a.sortOrder - b.sortOrder);
  const planEndRow = PLAN_START_ROW + plan.length - 1;

  cells.B2 = txt("PARÂMETROS GERAIS", S.title);
  cells.B4 = txt("Ano base", S.label);
  cells.C4 = num(input.year, S.premiseInt);
  cells.D4 = txt("Ano que a aba Fluxo Mensal consolida.", S.muted);
  cells.B5 = txt("Saldo inicial de caixa (01/jan)", S.label);
  cells.C5 = money(input.parameter.openingBalanceCents, S.premiseMoney);
  cells.D5 = txt("Soma dos saldos bancários no primeiro dia do ano base.", S.muted);
  cells.B6 = txt("Reserva mínima de caixa", S.label);
  cells.C6 = money(input.parameter.minimumReserveCents, S.premiseMoney);
  cells.D6 = txt("Piso de segurança. Sugestão: 1 mês de custo fixo.", S.muted);
  cells.B7 = txt("Meses com dados já realizados", S.label);
  cells.C7 = num(realizedMonths, S.premiseInt);
  cells.D7 = txt(
    input.parameter.realizedMonthsOverride !== undefined
      ? "Informado manualmente no app (override). Base da média da Projeção."
      : "Calculado pelo app: meses do ano com movimento realizado. Base da média da Projeção.",
    S.muted
  );

  cells.B9 = txt("CENÁRIOS DE PROJEÇÃO", S.section);
  cells.B10 = txt("Cenário", S.header);
  cells.C10 = txt("Ajuste nas receitas", S.header);
  cells.D10 = txt("Ajuste nas despesas", S.header);
  cells.E10 = txt("Crescimento mensal", S.header);
  input.scenarios.forEach((s, i) => {
    const r = SCENARIO_FIRST_ROW + i;
    cells[`B${r}`] = txt(s.name, S.label);
    cells[`C${r}`] = { num: bpToDecimal(s.revenueAdjustmentBp), style: S.premisePct };
    cells[`D${r}`] = { num: bpToDecimal(s.expenseAdjustmentBp), style: S.premisePct };
    cells[`E${r}`] = { num: bpToDecimal(s.monthlyGrowthBp), style: S.premisePct };
  });
  const afterScenarios = SCENARIO_FIRST_ROW + input.scenarios.length;
  cells[`B${afterScenarios}`] = txt(
    "Ajuste aplicado sobre a média mensal. 'Crescimento mensal' compõe mês a mês (deixe 0 para projeção plana).",
    S.muted
  );

  cells.B16 = txt("PLANO DE CATEGORIAS", S.section);
  cells.B17 = txt("Categoria", S.header);
  cells.C17 = txt("Tipo", S.header);
  cells.D17 = txt("Grupo", S.header);
  cells.E17 = txt("Classificação", S.header);
  plan.forEach((c, i) => {
    const r = PLAN_START_ROW + i;
    cells[`B${r}`] = txt(c.name);
    cells[`C${r}`] = txt(c.kind === "entrada" ? "Entrada" : "Saída");
    cells[`D${r}`] = txt(CASHFLOW_GROUP_LABEL[c.group]);
    cells[`E${r}`] = txt(c.classification === "fixo" ? "Fixo" : "Variável");
  });

  cells.G4 = txt("CENTROS DE CUSTO", S.header);
  const centros = input.costCenters.length > 0 ? input.costCenters : [];
  centros.forEach((cc, i) => {
    cells[`G${5 + i}`] = txt(cc.name, S.input);
  });
  const centrosEndRow = 5 + Math.max(centros.length, 1) - 1;
  cells.I4 = txt("Lista: Tipo", S.header);
  cells.I5 = txt("Entrada");
  cells.I6 = txt("Saída");
  cells.I8 = txt("Lista: Status", S.header);
  cells.I9 = txt("Realizado");
  cells.I10 = txt("Previsto");

  const sheet: XlsxGridSheet = {
    name: SHEET.parametros,
    cells,
    colWidths: { A: 3, B: 34, C: 26, D: 18, E: 18, F: 3, G: 30, H: 3, I: 16 },
    merges: ["B2:E2", "D4:E4", "D5:E5", "D6:E6", "D7:E7"],
  };
  return {
    sheet,
    planStartRow: PLAN_START_ROW,
    planEndRow,
    centrosEndRow,
    scenarioRow: (code) => {
      const i = input.scenarios.findIndex((s) => s.code === code);
      return i < 0 ? undefined : SCENARIO_FIRST_ROW + i;
    },
  };
}

// ---------------------------------------------------------------------------
// Aba Fluxo Mensal
// ---------------------------------------------------------------------------

interface MensalLayout {
  sheet: XlsxGridSheet;
  totalEntradasRow: number;
  totalSaidasRow: number;
  resultadoRow: number;
  saldoFinalRow: number;
  situacaoRow: number;
  subtotalRow: Partial<Record<(typeof CASHFLOW_EXPENSE_GROUPS)[number], number>>;
}

/** Coluna do mês m (0 = janeiro) na grade C..N; O = total do ano. */
const fmCol = (m: number) => columnLetter(2 + m);
const FM_TOTAL_COL = "O";

function buildMensal(input: CashflowWorkbookInput, lanc: LancamentosLayout): MensalLayout {
  const { monthly } = input;
  const cells: Cells = {};
  const catName = new Map(input.categories.map((c) => [c.id, c.name]));
  const months = Array.from({ length: 12 }, (_, m) => m);

  cells.B2 = txt("FLUXO DE CAIXA MENSAL — CONSOLIDADO (Previsto + Realizado)", S.title);
  cells.B3 = txt("Ano base", S.label);
  cells.C3 = fx(`${P}$C$4`, input.year, S.linkInt);
  cells.B5 = txt("Categoria", S.header);
  for (const m of months) {
    cells[`${fmCol(m)}4`] = num(m + 1, S.monthNo);
    cells[`${fmCol(m)}5`] = txt(monthLabel(`${input.year}-${String(m + 1).padStart(2, "0")}`).slice(0, 3).replace(/^\w/, (c) => c.toUpperCase()), S.header);
  }
  cells[`${FM_TOTAL_COL}5`] = txt("Total do Ano", S.header);

  // As linhas de categoria vêm da grade do app (inclui "A Classificar (entradas)" quando existe).
  const categoryRow = (row: MonthlyRow, r: number) => {
    cells[`B${r}`] = txt(row.name);
    const name = row.categoryId === CASHFLOW_UNCLASSIFIED_ID ? (catName.get(CASHFLOW_UNCLASSIFIED_ID) ?? "A Classificar") : undefined;
    const catCriterion = name ? `"${name}"` : `$B${r}`;
    const kindCriterion = row.categoryId === CASHFLOW_UNCLASSIFIED_ID ? `,${lanc.range("B")},"${TIPO_PLANILHA[row.kind === "entrada" ? "entrada" : "saida"]}"` : "";
    for (const m of months) {
      const c = fmCol(m);
      cells[`${c}${r}`] = fx(
        `SUMIFS(${lanc.range("G")},${lanc.range("C")},${catCriterion},${lanc.range("I")},${c}$4,${lanc.range("J")},$C$3${kindCriterion})`,
        cash(row.months[m]),
        S.money
      );
    }
    cells[`${FM_TOTAL_COL}${r}`] = fx(`SUM(C${r}:N${r})`, cash(row.totalCents), S.money);
  };
  const sumRow = (r: number, first: number, last: number, series: number[], total: number, style: XlsxStyle) => {
    for (const m of months) {
      const c = fmCol(m);
      cells[`${c}${r}`] = fx(`SUM(${c}${first}:${c}${last})`, cash(series[m]), style);
    }
    cells[`${FM_TOTAL_COL}${r}`] = fx(`SUM(${FM_TOTAL_COL}${first}:${FM_TOTAL_COL}${last})`, cash(total), style);
  };
  const bandRow = (r: number, style: XlsxStyle) => {
    for (const m of months) cells[`${fmCol(m)}${r}`] = { style };
    cells[`${FM_TOTAL_COL}${r}`] = { style };
  };

  let r = 8;
  cells[`B${r}`] = txt("ENTRADAS", S.section);
  bandRow(r, S.section);
  r += 1;
  const entradas = monthly.rows.filter((row) => row.kind === "entrada");
  const entradasFirst = r;
  for (const row of entradas) categoryRow(row, r++);
  const totalEntradasRow = r;
  cells[`B${r}`] = txt("TOTAL DE ENTRADAS", S.totalLabel);
  sumRow(r, entradasFirst, Math.max(entradasFirst, r - 1), monthly.entradasTotal, monthly.entradasAnoCents, S.total);
  r += 2;
  cells[`B${r}`] = txt("SAÍDAS", S.section);
  bandRow(r, S.section);
  r += 1;
  const subtotalRow: MensalLayout["subtotalRow"] = {};
  for (const group of CASHFLOW_EXPENSE_GROUPS) {
    const rows = monthly.rows.filter((row) => row.kind === "saida" && row.group === group);
    const first = r;
    for (const row of rows) categoryRow(row, r++);
    const sub = monthly.saidasGrupos.find((g) => g.group === group);
    cells[`B${r}`] = txt(`Subtotal ${CASHFLOW_GROUP_LABEL[group]}`, S.subtotalLabel);
    sumRow(r, first, Math.max(first, r - 1), sub?.months ?? months.map(() => 0), sub?.totalCents ?? 0, S.subtotal);
    subtotalRow[group] = r;
    r += 1;
  }
  const totalSaidasRow = r;
  cells[`B${r}`] = txt("TOTAL DE SAÍDAS", S.totalLabel);
  const subs = Object.values(subtotalRow) as number[];
  for (const m of months) {
    const c = fmCol(m);
    cells[`${c}${r}`] = fx(subs.map((s) => `${c}${s}`).join("+"), cash(monthly.saidasTotal[m]), S.total);
  }
  cells[`${FM_TOTAL_COL}${r}`] = fx(subs.map((s) => `${FM_TOTAL_COL}${s}`).join("+"), cash(monthly.saidasAnoCents), S.total);
  r += 2;
  const resultadoRow = r;
  cells[`B${r}`] = txt("RESULTADO DO MÊS (Entradas − Saídas)", S.totalLabel);
  for (const m of months) {
    const c = fmCol(m);
    cells[`${c}${r}`] = fx(`${c}${totalEntradasRow}-${c}${totalSaidasRow}`, cash(monthly.resultado[m]), S.total);
  }
  cells[`${FM_TOTAL_COL}${r}`] = fx(`${FM_TOTAL_COL}${totalEntradasRow}-${FM_TOTAL_COL}${totalSaidasRow}`, cash(monthly.resultadoAnoCents), S.total);
  r += 1;
  const saldoFinalRow = r;
  cells[`B${r}`] = txt("SALDO FINAL DE CAIXA", S.bandLabel);
  for (const m of months) {
    const c = fmCol(m);
    cells[`${c}${r}`] = fx(`${c}6+${c}${resultadoRow}`, cash(monthly.saldoFinal[m]), S.band);
  }
  cells[`${FM_TOTAL_COL}${r}`] = fx(`N${r}`, cash(monthly.saldoFinal[11]), S.band);
  r += 1;
  const situacaoRow = r;
  cells[`B${r}`] = txt("Situação vs. reserva mínima", S.label);
  for (const m of months) {
    const c = fmCol(m);
    cells[`${c}${r}`] = fx(
      `IF(${c}${saldoFinalRow}<0,"CAIXA NEGATIVO",IF(${c}${saldoFinalRow}<${P}$C$6,"Abaixo da reserva","OK"))`,
      CASH_SITUATION_LABEL[monthly.situacao[m]]
    );
  }

  // Saldo inicial: janeiro vem dos Parâmetros; os demais encadeiam do saldo final anterior.
  cells.B6 = txt("SALDO INICIAL", S.bandLabel);
  cells.C6 = fx(`${P}$C$5`, cash(monthly.saldoInicial[0]), { ...S.band, color: LINK });
  for (const m of months.slice(1)) {
    cells[`${fmCol(m)}6`] = fx(`${fmCol(m - 1)}${saldoFinalRow}`, cash(monthly.saldoInicial[m]), S.band);
  }
  cells[`${FM_TOTAL_COL}6`] = fx(`${P}$C$5`, cash(monthly.saldoInicial[0]), { ...S.band, color: LINK });

  const colWidths: Record<string, number> = { A: 2, B: 38 };
  for (const m of months) colWidths[fmCol(m)] = 14;
  colWidths[FM_TOTAL_COL] = 16;
  const sheet: XlsxGridSheet = { name: SHEET.mensal, cells, freeze: "C6", colWidths, merges: [`B2:${FM_TOTAL_COL}2`] };
  return { sheet, totalEntradasRow, totalSaidasRow, resultadoRow, saldoFinalRow, situacaoRow, subtotalRow };
}

// ---------------------------------------------------------------------------
// Aba Previsto x Realizado
// ---------------------------------------------------------------------------

const prCol = (m: number) => columnLetter(3 + m);
const PR_TOTAL_COL = "P";

function buildPrevistoRealizado(input: CashflowWorkbookInput, lanc: LancamentosLayout): XlsxGridSheet {
  const cells: Cells = {};
  const months = Array.from({ length: 12 }, (_, m) => m);
  cells.B2 = txt("PREVISTO x REALIZADO", S.title);
  cells.B3 = txt("Ano base", S.label);
  cells.C3 = fx(`${P}$C$4`, input.year, S.linkInt);
  cells.B5 = txt("Linha", S.header);
  cells.C5 = txt("Visão", S.header);
  for (const m of months) {
    cells[`${prCol(m)}4`] = num(m + 1, S.monthNo);
    cells[`${prCol(m)}5`] = txt(monthLabel(`${input.year}-${String(m + 1).padStart(2, "0")}`).slice(0, 3).replace(/^\w/, (c) => c.toUpperCase()), S.header);
  }
  cells[`${PR_TOTAL_COL}5`] = txt("Total", S.header);

  const merges: string[] = [`B2:${PR_TOTAL_COL}2`];
  let r = 6;
  for (const line of input.variance.lines) {
    const label =
      line.key === "entradas" ? "TOTAL DE ENTRADAS" : line.key === "saidas" ? "TOTAL DE SAÍDAS" : `Saídas — ${line.label}`;
    const criteria =
      line.key === "entradas"
        ? `${lanc.range("B")},"Entrada"`
        : line.key === "saidas"
          ? `${lanc.range("B")},"Saída"`
          : `${lanc.range("H")},"${line.label}",${lanc.range("B")},"Saída"`;
    cells[`B${r}`] = txt(label, S.label);
    merges.push(`B${r}:B${r + 2}`);
    cells[`C${r}`] = txt("Previsto");
    cells[`C${r + 1}`] = txt("Realizado");
    cells[`C${r + 2}`] = txt("Variação", S.bandLabel);
    for (const m of months) {
      const c = prCol(m);
      cells[`${c}${r}`] = fx(
        `SUMIFS(${lanc.range("G")},${criteria},${lanc.range("F")},"Previsto",${lanc.range("I")},${c}$4,${lanc.range("J")},$C$3)`,
        cash(line.previsto[m]),
        S.money
      );
      cells[`${c}${r + 1}`] = fx(
        `SUMIFS(${lanc.range("G")},${criteria},${lanc.range("F")},"Realizado",${lanc.range("I")},${c}$4,${lanc.range("J")},$C$3)`,
        cash(line.realizado[m]),
        S.money
      );
      cells[`${c}${r + 2}`] = fx(`${c}${r + 1}-${c}${r}`, cash(line.variacao[m]), S.bandPlain);
    }
    cells[`${PR_TOTAL_COL}${r}`] = fx(`SUM(D${r}:O${r})`, cash(line.previstoAnoCents), S.money);
    cells[`${PR_TOTAL_COL}${r + 1}`] = fx(`SUM(D${r + 1}:O${r + 1})`, cash(line.realizadoAnoCents), S.money);
    cells[`${PR_TOTAL_COL}${r + 2}`] = fx(`SUM(D${r + 2}:O${r + 2})`, cash(line.variacaoAnoCents), S.band);
    r += 4;
  }
  cells[`B${r + 1}`] = txt("Variação = Realizado − Previsto. Em saídas, valor positivo significa que gastou mais do que o planejado.", S.muted);

  const colWidths: Record<string, number> = { A: 2, B: 26, C: 11 };
  for (const m of months) colWidths[prCol(m)] = 14;
  colWidths[PR_TOTAL_COL] = 16;
  return { name: SHEET.previstoRealizado, cells, freeze: "D6", colWidths, merges };
}

// ---------------------------------------------------------------------------
// Aba Projeção
// ---------------------------------------------------------------------------

interface ProjecaoLayout {
  sheet: XlsxGridSheet;
  /** Linha do saldo acumulado e da linha-resumo de cada cenário. */
  saldoRow: Partial<Record<CashflowScenarioCode, number>>;
  resumoRow: Partial<Record<CashflowScenarioCode, number>>;
}

const pjCol = (i: number) => columnLetter(2 + i);
const SCENARIO_FILL: Record<CashflowScenarioCode, string> = { otimista: GREEN_BG, realista: GRAY, pessimista: RED_BG };

function buildProjecao(input: CashflowWorkbookInput, lanc: LancamentosLayout, params: ParametrosLayout): ProjecaoLayout {
  const { projection } = input;
  const cells: Cells = {};
  const horizon = Array.from({ length: 12 }, (_, i) => i);

  cells.B2 = txt("PROJEÇÃO DE CAIXA — 12 MESES, TRÊS CENÁRIOS", S.title);
  cells.B3 = txt("Meses com dados realizados", S.label);
  cells.C3 = fx(`${P}$C$7`, projection.realizedMonths, S.linkInt);
  cells.B4 = txt("Entradas realizadas no ano", S.label);
  cells.C4 = fx(
    `SUMIFS(${lanc.range("G")},${lanc.range("B")},"Entrada",${lanc.range("F")},"Realizado",${lanc.range("J")},${P}$C$4)`,
    cash(projection.realizedInCents),
    S.linkMoney
  );
  cells.B5 = txt("Saídas realizadas no ano", S.label);
  cells.C5 = fx(
    `SUMIFS(${lanc.range("G")},${lanc.range("B")},"Saída",${lanc.range("F")},"Realizado",${lanc.range("J")},${P}$C$4)`,
    cash(projection.realizedOutCents),
    S.linkMoney
  );
  cells.B6 = txt("Média mensal de entradas", S.label);
  cells.C6 = fx(`IFERROR($C$4/$C$3,0)`, cash(projection.avgInCents), S.money);
  cells.B7 = txt("Média mensal de saídas", S.label);
  cells.C7 = fx(`IFERROR($C$5/$C$3,0)`, cash(projection.avgOutCents), S.money);
  cells.B8 = txt("Saldo de caixa hoje (ponto de partida)", S.label);
  cells.C8 = fx(`${P}$C$5+$C$4-$C$5`, cash(projection.startingBalanceCents), S.linkMoney);
  cells.B9 = txt("Reserva mínima", S.label);
  cells.C9 = fx(`${P}$C$6`, cash(input.parameter.minimumReserveCents), S.linkMoney);
  cells.B10 = txt(
    `Ponto de partida = saldo inicial do ano + entradas realizadas − saídas realizadas. Horizonte a partir de ${monthLabel(projection.startMonth)}.${projection.lowConfidence ? " Menos de 3 meses realizados: confiabilidade baixa." : ""}`,
    S.muted
  );

  const firstScenarioMonths = projection.scenarios[0]?.months ?? [];
  cells.B12 = txt("Horizonte", S.header);
  for (const i of horizon) {
    const label = firstScenarioMonths[i] ? monthLabel(firstScenarioMonths[i].month) : "";
    if (label) cells[`${pjCol(i)}11`] = txt(label, S.monthNo);
    cells[`${pjCol(i)}12`] = txt(`M+${i + 1}`, S.header);
  }

  const saldoRow: ProjecaoLayout["saldoRow"] = {};
  const resumoRow: ProjecaoLayout["resumoRow"] = {};
  const merges: string[] = ["B2:N2"];
  let r = 13;
  for (const sc of projection.scenarios) {
    const pr = params.scenarioRow(sc.code);
    if (pr === undefined) continue;
    const fill = SCENARIO_FILL[sc.code];
    cells[`B${r}`] = txt(`CENÁRIO ${sc.name.toUpperCase()}`, S.section);
    for (const i of horizon) cells[`${pjCol(i)}${r}`] = { style: S.section };
    const eRow = r + 1;
    const sRow = r + 2;
    const resRow = r + 3;
    const salRow = r + 4;
    const sumRow = r + 5;
    cells[`B${eRow}`] = txt("Entradas projetadas");
    cells[`B${sRow}`] = txt("Saídas projetadas");
    cells[`B${resRow}`] = txt("Resultado do mês", S.label);
    cells[`B${salRow}`] = txt("Saldo acumulado", S.label);
    for (const i of horizon) {
      const c = pjCol(i);
      const m = sc.months[i];
      cells[`${c}${eRow}`] = fx(`$C$6*(1+${P}$C$${pr})*(1+${P}$E$${pr})^${i}`, m ? cash(m.inCents) : undefined, S.money);
      cells[`${c}${sRow}`] = fx(`$C$7*(1+${P}$D$${pr})*(1+${P}$E$${pr})^${i}`, m ? cash(m.outCents) : undefined, S.money);
      cells[`${c}${resRow}`] = fx(`${c}${eRow}-${c}${sRow}`, m ? cash(m.resultCents) : undefined, S.moneyBold);
      cells[`${c}${salRow}`] = fx(i === 0 ? `$C$8+${c}${resRow}` : `${pjCol(i - 1)}${salRow}+${c}${resRow}`, m ? cash(m.balanceCents) : undefined, S.band);
    }
    const summary: XlsxStyle = { bold: true, fill };
    cells[`B${sumRow}`] = txt("Meses abaixo da reserva mínima", summary);
    cells[`C${sumRow}`] = fx(`COUNTIF(C${salRow}:N${salRow},"<"&$C$9)`, sc.monthsBelowReserve, { fill, numFmt: "int" });
    cells[`D${sumRow}`] = txt("Meses com caixa negativo", summary);
    cells[`F${sumRow}`] = fx(`COUNTIF(C${salRow}:N${salRow},"<0")`, sc.monthsNegative, { fill, numFmt: "int" });
    cells[`G${sumRow}`] = txt("Saldo em 12 meses", summary);
    cells[`I${sumRow}`] = fx(`N${salRow}`, cash(sc.balance12Cents), { fill, numFmt: "brl", bold: true });
    merges.push(`D${sumRow}:E${sumRow}`, `G${sumRow}:H${sumRow}`);
    saldoRow[sc.code] = salRow;
    resumoRow[sc.code] = sumRow;
    r += 7;
  }
  cells[`B${r}`] = txt(
    "A projeção usa a média dos meses já realizados, ajustada pelos percentuais da aba Parâmetros. Com menos de 3 meses de histórico, a confiabilidade é baixa. Os valores em cache foram calculados pelo app com aritmética exata; o Excel pode diferir em centavos por arredondamento.",
    S.muted
  );

  const colWidths: Record<string, number> = { A: 2, B: 36 };
  for (const i of horizon) colWidths[pjCol(i)] = 14;
  return { sheet: { name: SHEET.projecao, cells, colWidths, merges }, saldoRow, resumoRow };
}

// ---------------------------------------------------------------------------
// Aba Dashboard
// ---------------------------------------------------------------------------

function buildDashboard(input: CashflowWorkbookInput, lanc: LancamentosLayout, fm: MensalLayout, pj: ProjecaoLayout): XlsxGridSheet {
  const cells: Cells = {};
  const { monthly } = input;
  const merges: string[] = ["B2:I2", "B3:I3", "B5:C5", "D5:E5", "F5:G5", "H5:I5", "B6:C6", "D6:E6", "F6:G6", "H6:I6", "B8:C8", "D8:E8", "F8:G8", "H8:I8", "B9:C9", "D9:E9", "F9:G9", "H9:I9"];
  const unclassifiedName = input.categories.find((c) => c.id === CASHFLOW_UNCLASSIFIED_ID)?.name ?? "A Classificar";

  cells.B2 = txt("DASHBOARD — FLUXO DE CAIXA", S.title);
  const countUnclassified = `COUNTIFS(${lanc.range("C")},"${unclassifiedName}",${lanc.range("J")},${P}$C$4)`;
  cells.B3 = fx(
    `IF(${countUnclassified}>0,"ATENÇÃO: "&${countUnclassified}&" lançamento(s) do ano base em ${unclassifiedName}. Classifique-os no app (Lançamentos → fila A classificar).","Todos os lançamentos do ano base estão classificados.")`,
    monthly.naoClassificadosCount > 0
      ? `ATENÇÃO: ${monthly.naoClassificadosCount} lançamento(s) do ano base em ${unclassifiedName}. Classifique-os no app (Lançamentos → fila A classificar).`
      : "Todos os lançamentos do ano base estão classificados.",
    { bold: true, color: monthly.naoClassificadosCount > 0 ? "C00000" : "375623", fill: monthly.naoClassificadosCount > 0 ? RED_BG : GREEN_BG }
  );

  cells.B5 = txt("Entradas no ano", S.header);
  cells.D5 = txt("Saídas no ano", S.header);
  cells.F5 = txt("Resultado no ano", S.header);
  cells.H5 = txt("Saldo final projetado (dez)", S.header);
  cells.B6 = fx(`${FM}${FM_TOTAL_COL}${fm.totalEntradasRow}`, cash(monthly.entradasAnoCents), S.kpi);
  cells.D6 = fx(`${FM}${FM_TOTAL_COL}${fm.totalSaidasRow}`, cash(monthly.saidasAnoCents), S.kpi);
  cells.F6 = fx(`${FM}${FM_TOTAL_COL}${fm.resultadoRow}`, cash(monthly.resultadoAnoCents), S.kpi);
  cells.H6 = fx(`${FM}N${fm.saldoFinalRow}`, cash(monthly.saldoFinal[11]), S.kpi);

  const scenarioKpi = (code: CashflowScenarioCode, col: string, fill: string) => {
    const sc = input.projection.scenarios.find((s) => s.code === code);
    const row = pj.saldoRow[code];
    cells[`${col}${9}`] =
      sc && row ? fx(`${PJ}N${row}`, cash(sc.balance12Cents), { ...S.kpi, fill }) : txt("—", { ...S.kpi, fill });
  };
  cells.B8 = txt("Saldo em 12m — Otimista", S.header);
  cells.D8 = txt("Saldo em 12m — Realista", S.header);
  cells.F8 = txt("Saldo em 12m — Pessimista", S.header);
  cells.H8 = txt("Meses de risco (pessimista)", S.header);
  scenarioKpi("otimista", "B", GREEN_BG);
  scenarioKpi("realista", "D", GRAY);
  scenarioKpi("pessimista", "F", RED_BG);
  const pess = input.projection.scenarios.find((s) => s.code === "pessimista");
  const pessResumo = pj.resumoRow.pessimista;
  cells.H9 = pess && pessResumo ? fx(`${PJ}C${pessResumo}`, pess.monthsBelowReserve, S.kpiInt) : txt("—", S.kpiInt);

  // Série mensal (fonte para gráficos): referencia a grade do Fluxo Mensal.
  let r = 11;
  cells[`B${r}`] = txt("Série mensal do ano base (fonte para gráficos)", S.section);
  r += 1;
  for (const [col, label] of [["B", "Mês"], ["C", "Entradas"], ["D", "Saídas"], ["E", "Resultado"], ["F", "Saldo final"], ["G", "Situação"]] as const) {
    cells[`${col}${r}`] = txt(label, S.header);
  }
  for (let m = 0; m < 12; m++) {
    const rr = r + 1 + m;
    const c = fmCol(m);
    cells[`B${rr}`] = txt(monthLabel(`${input.year}-${String(m + 1).padStart(2, "0")}`));
    cells[`C${rr}`] = fx(`${FM}${c}${fm.totalEntradasRow}`, cash(monthly.entradasTotal[m]), S.money);
    cells[`D${rr}`] = fx(`${FM}${c}${fm.totalSaidasRow}`, cash(monthly.saidasTotal[m]), S.money);
    cells[`E${rr}`] = fx(`${FM}${c}${fm.resultadoRow}`, cash(monthly.resultado[m]), S.money);
    cells[`F${rr}`] = fx(`${FM}${c}${fm.saldoFinalRow}`, cash(monthly.saldoFinal[m]), S.moneyBold);
    cells[`G${rr}`] = fx(`${FM}${c}${fm.situacaoRow}`, CASH_SITUATION_LABEL[monthly.situacao[m]]);
  }
  r += 14;

  cells[`B${r}`] = txt("Despesas por grupo (ano)", S.section);
  r += 1;
  cells[`B${r}`] = txt("Grupo", S.header);
  cells[`C${r}`] = txt("Total", S.header);
  cells[`D${r}`] = txt("% das saídas", S.header);
  for (const group of CASHFLOW_EXPENSE_GROUPS) {
    r += 1;
    const sub = monthly.saidasGrupos.find((g) => g.group === group);
    const subRow = fm.subtotalRow[group];
    cells[`B${r}`] = txt(CASHFLOW_GROUP_LABEL[group]);
    cells[`C${r}`] = subRow ? fx(`${FM}${FM_TOTAL_COL}${subRow}`, cash(sub?.totalCents ?? 0), S.linkMoney) : money(sub?.totalCents ?? 0);
    const share = monthly.saidasAnoCents > 0 ? Math.round(((sub?.totalCents ?? 0) * 10_000) / monthly.saidasAnoCents) : 0;
    cells[`D${r}`] = fx(`IFERROR(C${r}/$D$6,0)`, bpToDecimal(share), S.pct);
  }
  r += 2;

  cells[`B${r}`] = txt(`Alertas do app (calculados em ${formatStamp(input.generatedAt, input.timeZone)})`, S.section);
  r += 1;
  if (input.alerts.length === 0) {
    cells[`B${r}`] = txt("Nenhum alerta para o ano base com as premissas atuais.", S.muted);
    r += 1;
  } else {
    const sev: Record<CashflowAlert["severity"], string> = { info: "Informativo", warning: "Atenção", critical: "Crítico" };
    for (const a of input.alerts) {
      cells[`B${r}`] = txt(sev[a.severity], { bold: true, color: a.severity === "critical" ? "C00000" : a.severity === "warning" ? "9C5700" : "375623" });
      cells[`C${r}`] = txt(a.text);
      merges.push(`C${r}:I${r}`);
      r += 1;
    }
  }
  r += 1;
  cells[`B${r}`] = txt("Os gráficos da planilha original não são gerados pelo app: selecione a série mensal ou a tabela por grupo e insira um gráfico no Excel.", S.muted);
  merges.push(`B${r}:I${r}`);

  return { name: SHEET.dashboard, cells, colWidths: { A: 2, B: 22, C: 16, D: 16, E: 16, F: 16, G: 18, H: 18, I: 16 }, merges };
}

// ---------------------------------------------------------------------------
// Aba Instruções
// ---------------------------------------------------------------------------

function formatStamp(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

function buildInstrucoes(input: CashflowWorkbookInput, lanc: LancamentosLayout): XlsxGridSheet {
  const cells: Cells = {};
  const merges: string[] = ["B2:C2"];
  let r = 2;
  cells[`B${r}`] = txt("FLUXO DE CAIXA — CETEM", S.title);
  r = 4;
  const meta: Array<[string, string]> = [
    ["Gerado em", `${formatStamp(input.generatedAt, input.timeZone)} (${input.timeZone})`],
    ["Empresa", input.companyName],
    ["Ano base", String(input.year)],
    ["Gerado por", input.generatedBy],
    [
      "Origem dos dados",
      "Financeira PME — títulos a pagar e a receber, pagamentos, recebimentos, conciliação bancária e ajustes manuais, unificados sem dupla contagem (cada evento de caixa aparece uma única vez na aba Lançamentos, com a origem e a referência do registro original).",
    ],
    ["Lançamentos", `${input.entries.length} linha(s) reais, sem dados de exemplo. Parâmetros: ${input.parameter.configured ? "gravados no app" : "padrões (ainda não gravados no app)"}.`],
  ];
  for (const [k, v] of meta) {
    cells[`B${r}`] = txt(k, S.label);
    cells[`C${r}`] = txt(v, S.wrap);
    r += 1;
  }
  r += 1;
  cells[`B${r}`] = txt("COMO USAR", S.section);
  cells[`C${r}`] = { style: S.section };
  r += 1;
  const como: Array<[string, string]> = [
    ["1. Parâmetros", "Ano base, saldo inicial, reserva mínima, meses realizados, cenários e o plano de categorias vieram do app. Alterar aqui muda só esta planilha; para valer no app, altere na tela Parâmetros do Fluxo de Caixa."],
    ["2. Lançamentos", "Uma linha por evento de caixa: Data, Tipo, Categoria, Descrição, Centro de Custo, Status, Valor (sempre POSITIVO — o sinal vem do Tipo), mais Origem, Referência e apuração. Você pode acrescentar linhas novas logo abaixo dos dados (as listas e as fórmulas auxiliares já estão prontas)."],
    ["3. Status", "'Realizado' = já entrou ou saiu do banco (conciliação bancária ou baixa no app). 'Previsto' = título em aberto ou receita esperada. As duas somam no fluxo, e a aba Previsto x Realizado mostra a diferença."],
    ["4. Fluxo Mensal", "Consolida tudo por mês e por categoria, com saldo encadeado (o saldo final de um mês vira o inicial do seguinte). Não digite nada aqui."],
    ["5. Previsto x Realizado", "Previsto, realizado e variação por mês para entradas, saídas e cada grupo de saída. Não digite nada aqui."],
    ["6. Projeção", "Projeta 12 meses à frente em três cenários a partir da média dos meses realizados (Parâmetros, célula C7)."],
    ["7. Dashboard", "Resumo executivo: KPIs, série mensal, despesas por grupo e os alertas calculados pelo app. Atualiza sozinho."],
  ];
  for (const [k, v] of como) {
    cells[`B${r}`] = txt(k, S.label);
    cells[`C${r}`] = txt(v, S.wrap);
    r += 1;
  }
  r += 1;
  cells[`B${r}`] = txt("LEGENDA DE CORES", S.section);
  cells[`C${r}`] = { style: S.section };
  r += 1;
  const legenda: Array<[string, string, XlsxStyle]> = [
    ["Texto azul", "Célula de digitação (dados e premissas).", { bold: true, color: INPUT }],
    ["Texto preto", "Fórmula calculada na própria aba. Não sobrescreva.", S.label],
    ["Texto verde", "Fórmula que busca dado em outra aba. Não sobrescreva.", { bold: true, color: LINK }],
    ["Fundo amarelo", "Premissa-chave: muda o resultado de toda a planilha. Revise antes de apresentar.", { bold: true, fill: YELLOW }],
  ];
  for (const [k, v, st] of legenda) {
    cells[`B${r}`] = txt(k, st);
    cells[`C${r}`] = txt(v, S.wrap);
    r += 1;
  }
  r += 1;
  cells[`B${r}`] = txt("AVISOS", S.section);
  cells[`C${r}`] = { style: S.section };
  r += 1;
  const avisos: Array<[string, string]> = [
    ["Sem dados de exemplo", "Todas as linhas de Lançamentos são reais, exportadas do app no instante indicado acima."],
    [
      "Reimportação",
      "No app, Fluxo de Caixa → Lançamentos → Importar planilha lê só a aba Lançamentos. Linhas com Origem do app (Contas a pagar, Contas a receber, Conciliação bancária) e ajustes manuais já existentes são ignoradas — o app já os tem. Só linhas NOVAS (Origem em branco) viram ajustes manuais, com a observação 'importação planilha <arquivo>'. Qualquer linha com erro rejeita o arquivo inteiro: nada é gravado até tudo estar válido.",
    ],
    ["Transferência entre contas", "Transferência entre contas da própria empresa não é receita nem despesa: o app já a exclui (categoria neutra). Não lance."],
    ["Valores em cache", "As células de fórmula já trazem o resultado calculado pelo app; ao abrir, o Excel recalcula tudo. Na Projeção, diferenças de centavos por arredondamento são possíveis."],
    ["Limite da base", `As fórmulas leem até a linha ${lanc.lastRow} da aba Lançamentos (${LANC_SPARE_ROWS} linhas livres além dos dados). Passando disso, exporte de novo pelo app.`],
    ["Sem macros", "Arquivo .xlsx puro. Não pede ativação, não precisa habilitar conteúdo e não quebra ao ser aberto em outro PC."],
  ];
  for (const [k, v] of avisos) {
    cells[`B${r}`] = txt(k, S.label);
    cells[`C${r}`] = txt(v, S.wrap);
    r += 1;
  }
  return { name: SHEET.instrucoes, cells, colWidths: { A: 2, B: 30, C: 110 }, merges };
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export function buildCashflowWorkbookSpec(input: CashflowWorkbookInput): XlsxWorkbookSpec {
  const params = buildParametros(input, input.projection.realizedMonths);
  const lanc = buildLancamentos(input, params.planEndRow);
  const fm = buildMensal(input, lanc);
  const pr = buildPrevistoRealizado(input, lanc);
  const pj = buildProjecao(input, lanc, params);
  const dash = buildDashboard(input, lanc, fm, pj);
  const instr = buildInstrucoes(input, lanc);
  return {
    sheets: [instr, params.sheet, lanc.sheet, fm.sheet, pr, pj.sheet, dash],
    definedNames: [
      { name: "lista_categorias", ref: `${P}$B$${params.planStartRow}:$B$${params.planEndRow}` },
      { name: "lista_centros", ref: `${P}$G$5:$G$${params.centrosEndRow}` },
      { name: "lista_status", ref: `${P}$I$9:$I$10` },
      { name: "lista_tipo", ref: `${P}$I$5:$I$6` },
    ],
  };
}

export function buildCashflowWorkbook(input: CashflowWorkbookInput): Uint8Array {
  return buildXlsxWorkbook(buildCashflowWorkbookSpec(input));
}
