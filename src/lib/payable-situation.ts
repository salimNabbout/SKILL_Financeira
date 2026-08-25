/**
 * Situação DERIVADA de um título a pagar (apresentação). NÃO é persistida:
 * "Hoje" vira "Atrasado" à meia-noite sem ação do usuário, e o app não tem
 * agendador — um status gravado ficaria errado todo dia. PayableStatus continua
 * com os cinco valores de sempre; isto é só um rótulo calculado na leitura.
 *
 * A função é PURA: recebe `today` (data local da empresa) e a data de pagamento
 * por parâmetro — não lê relógio nem banco, para ser testável sem mock de tempo.
 */

import type { ISODate } from "@/core/dates";
import type { Payable } from "@/core/entities";

export type PayableSituation =
  | "A Vencer"
  | "Hoje"
  | "Atrasado"
  | "Pago"
  | "Pago Atraso"
  | "Cancelado";

/**
 * Deriva a situação do título.
 *
 * @param payable  título (usa status, dueDate, paidCents, amountCents)
 * @param today    data local da empresa (YYYY-MM-DD), NUNCA UTC
 * @param paidAt   data em que o título foi quitado (do pagamento que completou
 *                 o valor — o executedAt máximo). Só relevante quando status=paid.
 *
 * Precedência:
 *   cancelado                              → "Cancelado"
 *   pago + data de pagamento > vencimento  → "Pago Atraso"
 *   pago                                   → "Pago"
 *   vencimento  <  hoje                    → "Atrasado"
 *   vencimento === hoje                    → "Hoje"
 *   vencimento  >  hoje                    → "A Vencer"
 *
 * Um título parcialmente pago (paidCents > 0, status ≠ paid) segue as regras de
 * data pelo saldo remanescente: vencido → "Atrasado". A indicação de baixa
 * parcial é responsabilidade da UI (ver hasPartialPayment), não desta situação.
 */
export function derivePayableSituation(
  payable: Pick<Payable, "status" | "dueDate">,
  today: ISODate,
  paidAt?: ISODate
): PayableSituation {
  if (payable.status === "canceled") return "Cancelado";

  if (payable.status === "paid") {
    // Datas ISO comparam lexicograficamente. Pago no dia do vencimento NÃO é
    // atraso (só depois dele).
    if (paidAt && paidAt > payable.dueDate) return "Pago Atraso";
    return "Pago";
  }

  // Em aberto (open / scheduled / partially_paid): decide pelo vencimento.
  if (payable.dueDate < today) return "Atrasado";
  if (payable.dueDate === today) return "Hoje";
  return "A Vencer";
}

/** Título com baixa parcial ainda em aberto — a UI acrescenta "(parcial)". */
export function hasPartialPayment(payable: Pick<Payable, "status" | "paidCents">): boolean {
  return payable.status !== "paid" && payable.status !== "canceled" && payable.paidCents > 0;
}
