/**
 * Lógica pura de recorrência mensal. Sem dependência de banco/relógio —
 * testável isoladamente. Decide, para um template e uma data "hoje", se o
 * título do mês corrente deve ser gerado e qual o seu vencimento.
 */

import { endOfMonth, monthOf, type ISODate, type ISOMonth } from "@/core/dates";
import type { RecurringTemplate } from "@/core/entities";

/**
 * Vencimento do título no mês pedido: o `dueDay` do template, ou o último dia
 * do mês quando o mês não tem esse dia (ex.: dia 31 em fevereiro → dia 28/29).
 */
export function dueDateForMonth(template: RecurringTemplate, month: ISOMonth): ISODate {
  const last = endOfMonth(month); // "YYYY-MM-DD" do último dia
  const lastDay = Number(last.slice(8, 10));
  const day = Math.min(template.dueDay, lastDay);
  return `${month}-${String(day).padStart(2, "0")}`;
}

/**
 * Se o título do mês de `today` deve ser gerado, retorna o mês ("YYYY-MM");
 * senão, null. Gera quando: status active, e o mês de hoje está dentro de
 * [mês do startDate, mês do endDate] (endDate ausente = indefinido).
 * A geração é "no início do mês": basta o mês corrente estar no período.
 */
export function shouldGenerateFor(
  template: RecurringTemplate,
  today: ISODate
): ISOMonth | null {
  if (template.status !== "active") return null;
  const month = monthOf(today);
  if (month < monthOf(template.startDate)) return null;
  if (template.endDate && month > monthOf(template.endDate)) return null;
  return month;
}
