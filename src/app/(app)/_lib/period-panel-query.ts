/**
 * Estado dos filtros do Painel por Período e sua ida e volta com a query
 * string da URL (ano, mes, de, ate, cc, cat). Módulo puro, compartilhado pela
 * página (Server Component) e pelo painel (Client Component).
 */

import { endOfMonth, type ISODate } from "@/core/dates";

export type PanelMonth = number | "todos";

export interface PanelQueryState {
  ano: number;
  mes: PanelMonth;
  de: number;
  ate: number;
  /** id do centro de custo; "" = Todos */
  cc: string;
  /** nome da categoria de fornecedor; "" = Todos */
  cat: string;
}

export const MONTH_LABELS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
] as const;

export function daysInMonthOf(ano: number, mes: number): number {
  return Number(endOfMonth(`${ano}-${String(mes).padStart(2, "0")}`).slice(8, 10));
}

const toInt = (v: string | undefined): number | undefined => {
  if (v === undefined || !/^\d{1,4}$/.test(v)) return undefined;
  return Number(v);
};

/**
 * Query da URL → estado. Padrão ao abrir: ano e mês correntes, dia 1 até o
 * último dia. Dias fora do mês são ajustados; dia inicial > final vira 1..fim.
 */
export function parsePanelQuery(
  sp: Record<string, string | string[] | undefined>,
  today: ISODate
): PanelQueryState {
  const pick = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const anoHoje = Number(today.slice(0, 4));
  const mesHoje = Number(today.slice(5, 7));
  const ano = toInt(pick("ano")) ?? anoHoje;
  const mesRaw = pick("mes");
  const mes: PanelMonth =
    mesRaw === "todos" ? "todos" : ((v) => (v !== undefined && v >= 1 && v <= 12 ? v : mesHoje))(toInt(mesRaw));
  if (mes === "todos") return { ano, mes, de: 1, ate: 31, cc: pick("cc") ?? "", cat: pick("cat") ?? "" };
  const dias = daysInMonthOf(ano, mes);
  let de = Math.min(Math.max(toInt(pick("de")) ?? 1, 1), dias);
  let ate = Math.min(Math.max(toInt(pick("ate")) ?? dias, 1), dias);
  if (de > ate) {
    de = 1;
    ate = dias;
  }
  return { ano, mes, de, ate, cc: pick("cc") ?? "", cat: pick("cat") ?? "" };
}

/** Estado → query string (sem "?"), só com o que difere do vazio. */
export function panelQueryToSearch(state: PanelQueryState): string {
  const qs = new URLSearchParams();
  qs.set("ano", String(state.ano));
  qs.set("mes", String(state.mes));
  if (state.mes !== "todos") {
    qs.set("de", String(state.de));
    qs.set("ate", String(state.ate));
  }
  if (state.cc) qs.set("cc", state.cc);
  if (state.cat) qs.set("cat", state.cat);
  return qs.toString();
}
