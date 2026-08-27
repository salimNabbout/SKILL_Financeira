/**
 * Filtros da listagem de Contas a Pagar, derivados dos searchParams.
 *
 * Compartilhado pela página, pela exportação (CSV/PDF) e pela visão de
 * impressão: se cada uma reinterpretasse os parâmetros, o arquivo exportado
 * poderia divergir do que está na tela — que é justamente o que ninguém
 * percebe até conferir um total errado.
 *
 * Função pura, sem dependência de Next/server.
 */

import { endOfMonth, isISODate, startOfMonth, type ISODate } from "@/core/dates";
import type { PayableStatus } from "@/core/entities";

export type StatusFilter = PayableStatus | "todos";

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "open", label: "Em aberto" },
  { value: "scheduled", label: "Agendados" },
  { value: "partially_paid", label: "Pagos parcial" },
  { value: "paid", label: "Pagos" },
  { value: "canceled", label: "Cancelados" },
];

/** Parâmetros de filtro aceitos na URL. */
export interface PayableFilterParams {
  status?: string;
  ano?: string;
  mes?: string;
  fornecedor?: string;
  de?: string;
  ate?: string;
}

export interface PayableFilters {
  status: StatusFilter;
  statuses?: PayableStatus[];
  supplierId?: string;
  dueFrom?: ISODate;
  dueTo?: ISODate;
  /** Ano/mês reconhecidos, para reexibir a seleção nos formulários. */
  ano?: number;
  mes?: number;
  de?: ISODate;
  ate?: ISODate;
  /** true quando a data inicial é maior que a final (a página redireciona). */
  periodoInvalido: boolean;
}

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

/**
 * Traduz os parâmetros da URL em filtros de repositório.
 *
 * Precedência: o período explícito (de/ate) vence Ano/Mês — quem digitou datas
 * quis aquelas datas.
 */
export function parsePayableFilters(sp: PayableFilterParams): PayableFilters {
  const status = STATUS_FILTERS.some((f) => f.value === sp.status)
    ? (sp.status as StatusFilter)
    : "todos";

  const de = sp.de && isISODate(sp.de) ? (sp.de as ISODate) : undefined;
  const ate = sp.ate && isISODate(sp.ate) ? (sp.ate as ISODate) : undefined;
  const periodoInvalido = Boolean(de && ate && de > ate);

  const ano = sp.ano && /^\d{4}$/.test(sp.ano) ? Number(sp.ano) : undefined;
  const mesBruto = sp.mes && /^\d{1,2}$/.test(sp.mes) ? Number(sp.mes) : undefined;
  const mes = mesBruto !== undefined && mesBruto >= 1 && mesBruto <= 12 ? mesBruto : undefined;

  let dueFrom: ISODate | undefined;
  let dueTo: ISODate | undefined;
  if (de || ate) {
    dueFrom = de;
    dueTo = ate;
  } else if (ano) {
    if (mes) {
      const monthKey = `${ano}-${String(mes).padStart(2, "0")}`;
      dueFrom = startOfMonth(monthKey);
      dueTo = endOfMonth(monthKey);
    } else {
      dueFrom = `${ano}-01-01`;
      dueTo = `${ano}-12-31`;
    }
  }

  return {
    status,
    statuses: status === "todos" ? undefined : [status as PayableStatus],
    supplierId: sp.fornecedor || undefined,
    dueFrom,
    dueTo,
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
 * Descrição legível dos filtros, para o cabeçalho do PDF e da impressão —
 * sem isso, um relatório impresso não diz a que recorte se refere.
 */
export function describeFilters(f: PayableFilters, supplierName?: string): string {
  const partes: string[] = [];
  const rotulo = STATUS_FILTERS.find((s) => s.value === f.status)?.label ?? "Todos";
  partes.push(`Status: ${rotulo}`);
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
