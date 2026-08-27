/**
 * Filtros da listagem de Contas a Pagar, derivados dos searchParams.
 *
 * Compartilhado pela página, pela exportação (CSV/PDF) e pela visão de
 * impressão: se cada uma reinterpretasse os parâmetros, o arquivo exportado
 * poderia divergir do que está na tela — e ninguém percebe até conferir um
 * total errado.
 *
 * Função pura, sem dependência de Next/server.
 */

import { addDays, endOfMonth, isISODate, startOfMonth, type ISODate } from "@/core/dates";
import type { PayableStatus } from "@/core/entities";

export type SituacaoFiltro = "todos" | "a_vencer" | "hoje" | "atrasado" | "pago" | "cancelado";

export const SITUACAO_FILTERS: Array<{ value: SituacaoFiltro; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "a_vencer", label: "A Vencer" },
  { value: "hoje", label: "Hoje" },
  { value: "atrasado", label: "Atrasado" },
  { value: "pago", label: "Pago" },
  { value: "cancelado", label: "Cancelados" },
];

/** Status "em aberto": as situações por data recaem sobre estes. */
export const OPEN_STATUSES: PayableStatus[] = ["open", "scheduled", "partially_paid"];

export const MESES = [
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
];

export interface PayableFilterParams {
  /** Na URL o parâmetro chama-se `status`, mas carrega a SITUAÇÃO derivada
   *  (a_vencer/hoje/atrasado/pago/cancelado) — nome mantido para não quebrar
   *  links já existentes. */
  status?: string;
  ano?: string;
  mes?: string;
  fornecedor?: string;
  de?: string;
  ate?: string;
}

export interface PayableFilters {
  situacao: SituacaoFiltro;
  statuses?: PayableStatus[];
  supplierId?: string;
  dueFrom?: ISODate;
  dueTo?: ISODate;
  ano?: number;
  mes?: number;
  de?: ISODate;
  ate?: ISODate;
  periodoInvalido: boolean;
}

function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}
function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

/**
 * Traduz os parâmetros da URL nos mesmos filtros que a listagem aplica.
 *
 * Espelha a lógica da página: a situação vira recorte de status + intervalo de
 * vencimento relativo a HOJE, e esse intervalo é intersectado com o período
 * escolhido (from = max, to = min), para um filtro não sobrescrever o outro.
 */
export function parsePayableFilters(sp: PayableFilterParams, today: ISODate): PayableFilters {
  const situacao = SITUACAO_FILTERS.some((f) => f.value === sp.status)
    ? (sp.status as SituacaoFiltro)
    : "todos";

  const de = sp.de && isISODate(sp.de) ? (sp.de as ISODate) : undefined;
  const ate = sp.ate && isISODate(sp.ate) ? (sp.ate as ISODate) : undefined;
  const periodoInvalido = Boolean(de && ate && de > ate);

  const ano = sp.ano && /^\d{4}$/.test(sp.ano) ? Number(sp.ano) : undefined;
  const mesBruto = sp.mes && /^\d{1,2}$/.test(sp.mes) ? Number(sp.mes) : undefined;
  const mes = mesBruto !== undefined && mesBruto >= 1 && mesBruto <= 12 ? mesBruto : undefined;

  let periodoFrom: ISODate | undefined;
  let periodoTo: ISODate | undefined;
  if (de || ate) {
    periodoFrom = de;
    periodoTo = ate;
  } else if (ano) {
    if (mes) {
      const monthKey = `${ano}-${String(mes).padStart(2, "0")}`;
      periodoFrom = startOfMonth(monthKey);
      periodoTo = endOfMonth(monthKey);
    } else {
      periodoFrom = `${ano}-01-01`;
      periodoTo = `${ano}-12-31`;
    }
  }

  const ontem = addDays(today, -1);
  const amanha = addDays(today, 1);
  let statuses: PayableStatus[] | undefined;
  let situacaoFrom: ISODate | undefined;
  let situacaoTo: ISODate | undefined;
  switch (situacao) {
    case "a_vencer":
      statuses = OPEN_STATUSES;
      situacaoFrom = amanha;
      break;
    case "hoje":
      statuses = OPEN_STATUSES;
      situacaoFrom = today;
      situacaoTo = today;
      break;
    case "atrasado":
      statuses = OPEN_STATUSES;
      situacaoTo = ontem;
      break;
    case "pago":
      statuses = ["paid"];
      break;
    case "cancelado":
      statuses = ["canceled"];
      break;
    case "todos":
      statuses = undefined;
      break;
  }

  return {
    situacao,
    statuses,
    supplierId: sp.fornecedor || undefined,
    dueFrom:
      situacaoFrom && periodoFrom ? maxDate(situacaoFrom, periodoFrom) : (situacaoFrom ?? periodoFrom),
    dueTo: situacaoTo && periodoTo ? minDate(situacaoTo, periodoTo) : (situacaoTo ?? periodoTo),
    ano,
    mes,
    de,
    ate,
    periodoInvalido,
  };
}

/** Query string com os filtros ativos, para links de export/impressão. */
export function filtersToQuery(sp: PayableFilterParams): string {
  const params = new URLSearchParams();
  for (const chave of ["status", "ano", "mes", "fornecedor", "de", "ate"] as const) {
    const valor = sp[chave];
    if (valor) params.set(chave, valor);
  }
  const q = params.toString();
  return q ? `&${q}` : "";
}

/**
 * Descrição legível dos filtros, para o cabeçalho do PDF e da impressão — sem
 * isso, um relatório impresso não diz a que recorte se refere.
 */
export function describeFilters(f: PayableFilters, supplierName?: string): string {
  const partes: string[] = [];
  partes.push(`Situação: ${SITUACAO_FILTERS.find((s) => s.value === f.situacao)?.label ?? "Todos"}`);
  if (supplierName) partes.push(`Fornecedor: ${supplierName}`);
  if (f.de || f.ate) {
    const ini = f.de ? f.de.split("-").reverse().join("/") : "início";
    const fim = f.ate ? f.ate.split("-").reverse().join("/") : "hoje";
    partes.push(`Vencimento: ${ini} a ${fim}`);
  } else if (f.ano) {
    partes.push(f.mes ? `Vencimento: ${MESES[f.mes - 1]}/${f.ano}` : `Vencimento: ${f.ano}`);
  }
  return partes.join(" · ");
}
