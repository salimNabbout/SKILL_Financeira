/**
 * Cálculo da Agenda financeira — funções puras, separadas da página para
 * serem testáveis (a página só consulta os títulos do mês e compõe a grade).
 *
 * Fórmulas (auditadas em __tests__/agenda-month.test.ts):
 * - Universo do mês: títulos com VENCIMENTO dentro do mês e status em aberto
 *   (a pagar: open, partially_paid, scheduled; a receber: open,
 *   partially_received). Pagos/recebidos e cancelados ficam de fora.
 * - Saídas do dia   = Σ max(0, amountCents − paidCents) dos a pagar com vencimento no dia
 * - Entradas do dia = Σ max(0, amountCents − receivedCents) dos a receber com vencimento no dia
 * - Líquido do dia  = entradas − saídas
 * - A pagar / A receber / Líquido do mês = somas dos dias
 * Vencidos e ainda em aberto continuam no dia do vencimento (a grade os marca).
 */

import { endOfMonth, type ISODate, type ISOMonth } from "@/core/dates";
import type { Payable, PayableStatus, Receivable, ReceivableStatus } from "@/core/entities";
import { payableRemainingCents, receivableRemainingCents } from "@/core/money";

// Mesma semântica de OPEN_STATUSES da skill contas-a-pagar: só títulos em
// aberto entram na agenda (pagos/recebidos e cancelados ficam de fora).
export const PAYABLE_OPEN: readonly PayableStatus[] = ["open", "partially_paid", "scheduled"];
export const RECEIVABLE_OPEN: readonly ReceivableStatus[] = ["open", "partially_received"];

export const AGENDA_FORMULAS = {
  outCents:
    "saídas do dia = Σ max(0, amountCents − paidCents) dos títulos a pagar em aberto (open, partially_paid, scheduled) com dueDate no dia",
  inCents:
    "entradas do dia = Σ max(0, amountCents − receivedCents) dos títulos a receber em aberto (open, partially_received) com dueDate no dia",
  month: "A pagar / A receber / Líquido do mês = Σ dos dias do mês; líquido = entradas − saídas",
} as const;

/** Item de título já resolvido para exibição (nome da contraparte + saldo). */
export interface AgendaItem {
  id: string;
  party: string;
  description: string;
  remainingCents: number;
  dueDate: ISODate;
}

export interface DayCell {
  day: number; // 1..N
  date: ISODate;
  payables: AgendaItem[];
  receivables: AgendaItem[];
  outCents: number; // saídas (a pagar)
  inCents: number; // entradas (a receber)
  netCents: number; // entradas - saídas
}

export interface AgendaMonth {
  month: ISOMonth;
  daysInMonth: number;
  /** Dia da semana (0 = domingo) do dia 1 — para as células vazias iniciais. */
  firstWeekday: number;
  cells: DayCell[];
  monthOutCents: number;
  monthInCents: number;
  monthNetCents: number;
  hasMovement: boolean;
  /** Detalhamento: títulos do mês ordenados por vencimento, desempate por id. */
  monthPayables: AgendaItem[];
  monthReceivables: AgendaItem[];
}

export interface PartyNames {
  supplier: (id: string) => string;
  customer: (id: string) => string;
}

/** Mês exibido: dos searchParams (validados), senão o mês de hoje. */
export function resolveAgendaMonth(
  today: ISODate,
  ano?: string,
  mes?: string
): { month: ISOMonth; anoNum: number; mesNum: number } {
  const anoNum = ano && /^\d{4}$/.test(ano) ? Number(ano) : Number(today.slice(0, 4));
  const mesNum =
    mes && /^\d{1,2}$/.test(mes) && Number(mes) >= 1 && Number(mes) <= 12
      ? Number(mes)
      : Number(today.slice(5, 7));
  return { month: `${anoNum}-${String(mesNum).padStart(2, "0")}`, anoNum, mesNum };
}

function byDueDateThenId(a: AgendaItem, b: AgendaItem): number {
  return a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate.localeCompare(b.dueDate);
}

/**
 * Agrega os títulos do mês por dia de vencimento. Recebe os títulos já
 * consultados pelo intervalo do mês; filtra os status em aberto e ignora
 * qualquer título cujo vencimento não caia no mês (defensivo).
 */
export function buildAgendaMonth(
  month: ISOMonth,
  payablesRaw: readonly Payable[],
  receivablesRaw: readonly Receivable[],
  names: PartyNames
): AgendaMonth {
  const daysInMonth = Number(endOfMonth(month).slice(8, 10));
  const [anoNum, mesNum] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(anoNum, mesNum - 1, 1)).getUTCDay();

  const payables = payablesRaw.filter(
    (p) => PAYABLE_OPEN.includes(p.status) && p.dueDate.slice(0, 7) === month
  );
  const receivables = receivablesRaw.filter(
    (r) => RECEIVABLE_OPEN.includes(r.status) && r.dueDate.slice(0, 7) === month
  );

  const cells: DayCell[] = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    return {
      day,
      date: `${month}-${String(day).padStart(2, "0")}`,
      payables: [],
      receivables: [],
      outCents: 0,
      inCents: 0,
      netCents: 0,
    };
  });

  const monthPayables: AgendaItem[] = [];
  for (const p of payables) {
    const cell = cells[Number(p.dueDate.slice(8, 10)) - 1];
    if (!cell) continue;
    const item: AgendaItem = {
      id: p.id,
      party: names.supplier(p.supplierId),
      description: p.description,
      remainingCents: payableRemainingCents(p),
      dueDate: p.dueDate,
    };
    cell.payables.push(item);
    cell.outCents += item.remainingCents;
    monthPayables.push(item);
  }
  const monthReceivables: AgendaItem[] = [];
  for (const r of receivables) {
    const cell = cells[Number(r.dueDate.slice(8, 10)) - 1];
    if (!cell) continue;
    const item: AgendaItem = {
      id: r.id,
      party: names.customer(r.customerId),
      description: r.description,
      remainingCents: receivableRemainingCents(r),
      dueDate: r.dueDate,
    };
    cell.receivables.push(item);
    cell.inCents += item.remainingCents;
    monthReceivables.push(item);
  }
  for (const c of cells) c.netCents = c.inCents - c.outCents;

  const monthOutCents = cells.reduce((acc, c) => acc + c.outCents, 0);
  const monthInCents = cells.reduce((acc, c) => acc + c.inCents, 0);

  return {
    month,
    daysInMonth,
    firstWeekday,
    cells,
    monthOutCents,
    monthInCents,
    monthNetCents: monthInCents - monthOutCents,
    hasMovement: payables.length > 0 || receivables.length > 0,
    monthPayables: monthPayables.sort(byDueDateThenId),
    monthReceivables: monthReceivables.sort(byDueDateThenId),
  };
}
