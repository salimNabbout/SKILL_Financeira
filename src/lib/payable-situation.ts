/**
 * Situação DERIVADA de um título a PAGAR (apresentação). NÃO é persistida:
 * "Hoje" vira "Atrasado" à meia-noite sem ação do usuário, e o app não tem
 * agendador — um status gravado ficaria errado todo dia. PayableStatus continua
 * com os cinco valores de sempre; isto é só um rótulo calculado na leitura.
 *
 * A lógica de datas/precedência vive em `deriveSituation` (genérica, comum a
 * pagar e receber). Aqui só se traduz o enum abstrato para o rótulo pt-BR do
 * lado "a pagar" ("Pago" / "Pago Atraso"). A função continua PURA: recebe
 * `today` e a data de pagamento por parâmetro.
 */

import type { ISODate } from "@/core/dates";
import type { Payable } from "@/core/entities";
import { deriveSituation, type Situation } from "@/lib/situation";

export type PayableSituation =
  | "A Vencer"
  | "Hoje"
  | "Atrasado"
  | "Pago"
  | "Pago Atraso"
  | "Cancelado";

/** Enum abstrato → rótulo pt-BR do lado a PAGAR. */
const PAYABLE_LABEL: Record<Situation, PayableSituation> = {
  a_vencer: "A Vencer",
  hoje: "Hoje",
  atrasado: "Atrasado",
  quitado: "Pago",
  quitado_atraso: "Pago Atraso",
  cancelado: "Cancelado",
};

/**
 * Deriva a situação do título a pagar. Delega a precedência a `deriveSituation`
 * (comum aos dois lados) e traduz para o rótulo de "a pagar".
 *
 * @param payable  título (usa status, dueDate)
 * @param today    data local da empresa (YYYY-MM-DD), NUNCA UTC
 * @param paidAt   data em que o título foi quitado (do pagamento que completou
 *                 o valor — o executedAt máximo). Só relevante quando pago.
 */
export function derivePayableSituation(
  payable: Pick<Payable, "status" | "dueDate">,
  today: ISODate,
  paidAt?: ISODate
): PayableSituation {
  const status =
    payable.status === "canceled" ? "canceled" : payable.status === "paid" ? "settled" : "open";
  const situation = deriveSituation(
    // remainingCents não afeta a precedência; passa 0 (o rótulo "(parcial)" é da UI).
    { status, dueDate: payable.dueDate, remainingCents: 0, settledAt: paidAt },
    today
  );
  return PAYABLE_LABEL[situation];
}

/** Título com baixa parcial ainda em aberto — a UI acrescenta "(parcial)". */
export function hasPartialPayment(payable: Pick<Payable, "status" | "paidCents">): boolean {
  return payable.status !== "paid" && payable.status !== "canceled" && payable.paidCents > 0;
}
