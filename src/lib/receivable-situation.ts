/**
 * Situação DERIVADA de um título a RECEBER (apresentação). NÃO é persistida:
 * "Hoje" vira "Atrasado" à meia-noite sem ação do usuário, e o app não tem
 * agendador. ReceivableStatus continua com os quatro valores de sempre; isto é
 * só um rótulo calculado na leitura.
 *
 * A lógica de datas/precedência vive em `deriveSituation` (genérica, comum a
 * pagar e receber). Aqui só se traduz o enum abstrato para o rótulo pt-BR do
 * lado "a receber" ("Recebido" / "Recebido em Atraso"). PURA: recebe `today` e
 * a data de recebimento por parâmetro.
 */

import type { ISODate } from "@/core/dates";
import type { Receivable } from "@/core/entities";
import { deriveSituation, type Situation } from "@/lib/situation";

export type ReceivableSituation =
  | "A Vencer"
  | "Hoje"
  | "Atrasado"
  | "Recebido"
  | "Recebido em Atraso"
  | "Cancelado";

/** Enum abstrato → rótulo pt-BR do lado a RECEBER. */
const RECEIVABLE_LABEL: Record<Situation, ReceivableSituation> = {
  a_vencer: "A Vencer",
  hoje: "Hoje",
  atrasado: "Atrasado",
  quitado: "Recebido",
  quitado_atraso: "Recebido em Atraso",
  cancelado: "Cancelado",
};

/**
 * Deriva a situação do título a receber. Delega a precedência a
 * `deriveSituation` (comum aos dois lados) e traduz para o rótulo de "a receber".
 *
 * @param receivable  título (usa status, dueDate)
 * @param today       data local da empresa (YYYY-MM-DD), NUNCA UTC
 * @param receivedAt  data em que o título foi quitado (do recebimento que
 *                    completou o valor — o receivedDate máximo). Só relevante
 *                    quando status = received. Já é ISODate (sem fuso a converter).
 */
export function deriveReceivableSituation(
  receivable: Pick<Receivable, "status" | "dueDate">,
  today: ISODate,
  receivedAt?: ISODate
): ReceivableSituation {
  const status =
    receivable.status === "canceled"
      ? "canceled"
      : receivable.status === "received"
        ? "settled"
        : "open";
  const situation = deriveSituation(
    // remainingCents não afeta a precedência; o rótulo "(parcial)" é da UI.
    { status, dueDate: receivable.dueDate, remainingCents: 0, settledAt: receivedAt },
    today
  );
  return RECEIVABLE_LABEL[situation];
}

/** Título com baixa parcial ainda em aberto — a UI acrescenta "(parcial)". */
export function hasPartialReceipt(
  receivable: Pick<Receivable, "status" | "receivedCents">
): boolean {
  return (
    receivable.status !== "received" &&
    receivable.status !== "canceled" &&
    receivable.receivedCents > 0
  );
}
