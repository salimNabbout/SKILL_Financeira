/**
 * Derivação GENÉRICA de situação de um título (a pagar OU a receber), para
 * apresentação. NÃO é persistida: "Hoje" vira "Atrasado" à meia-noite sem ação
 * do usuário, e o app não tem agendador. Serve os dois lados sem duplicar a
 * lógica de datas/precedência; cada lado só mapeia o enum para o rótulo pt-BR
 * ("Pago" vs "Recebido").
 *
 * PURA: recebe `today` (data local da empresa) e a data de liquidação por
 * parâmetro — não lê relógio nem banco, para ser testável sem mock de tempo.
 */

import type { ISODate } from "@/core/dates";

/** Situação abstrata (sem rótulo pt-BR); cada tela traduz para o seu texto. */
export type Situation =
  | "a_vencer"
  | "hoje"
  | "atrasado"
  | "quitado"
  | "quitado_atraso"
  | "cancelado";

/** Estado de liquidação, normalizado pelo chamador a partir do seu próprio enum. */
export type SettlementState = "open" | "settled" | "canceled";

export interface SituationInput {
  /** Liquidação normalizada: paid/received → "settled"; canceled → "canceled". */
  status: SettlementState;
  dueDate: ISODate;
  /** Saldo em aberto (amount − pago/recebido). Reservado para uso da UI; a
   *  precedência principal não depende dele — o rótulo "(parcial)" é da tela. */
  remainingCents: number;
  /** Data em que o título foi quitado (pagamento/recebimento que completou o
   *  valor). Só relevante quando status = "settled". */
  settledAt?: ISODate;
}

/**
 * Precedência (idêntica à que Contas a Pagar já usava):
 *   cancelado                                → "cancelado"
 *   quitado + data de liquidação > vencimento → "quitado_atraso"
 *   quitado                                  → "quitado"
 *   vencimento  <  hoje                      → "atrasado"
 *   vencimento === hoje                      → "hoje"
 *   vencimento  >  hoje                      → "a_vencer"
 */
export function deriveSituation(input: SituationInput, today: ISODate): Situation {
  if (input.status === "canceled") return "cancelado";

  if (input.status === "settled") {
    // Datas ISO comparam lexicograficamente. Quitado no dia do vencimento NÃO é
    // atraso (só depois dele).
    if (input.settledAt && input.settledAt > input.dueDate) return "quitado_atraso";
    return "quitado";
  }

  // Em aberto (open / parcial): decide pelo vencimento (pelo saldo remanescente).
  if (input.dueDate < today) return "atrasado";
  if (input.dueDate === today) return "hoje";
  return "a_vencer";
}
