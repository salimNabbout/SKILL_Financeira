/**
 * Saldo de uma conta bancária num período, a partir do extrato conciliado.
 *
 *   SALDO = SALDO_INICIAL + TOTAL_ENTRADAS − TOTAL_SAIDAS
 *
 * Três traduções entre a regra de negócio e o modelo, que valem registro:
 *
 * 1. Não existe campo de tipo (entrada/saída). `BankTransaction.amountCents` é
 *    ASSINADO — crédito > 0, débito < 0 — e é o sinal que classifica. Os totais
 *    saem daqui em MÓDULO: quem soma é a fórmula, não o valor gravado.
 * 2. Não existe status de lançamento, só o booleano `reconciled`. Rejeitar um
 *    match devolve `reconciled = false`, então pendente, cancelado e estornado
 *    já ficam de fora pelo mesmo filtro.
 * 3. Não existe data de conciliação no modelo. O recorte é pela data do
 *    lançamento no extrato (`date`) — é a única que faz o saldo bater com o
 *    extrato real do banco no período.
 *
 * A função é pura de propósito: recebe o que já foi carregado e não toca em
 * repositório, para ser testável sem banco. O escopo de empresa é do chamador:
 * o repositório já entrega o extrato da empresa da sessão.
 *
 * DÍVIDA REGISTRADA: já existem três somas de `openingBalanceCents + Σ
 * amountCents` espalhadas — `loadCashBase` (skills/tesouraria), `loadBankBase`
 * (skills/relatorios) e um `startingBalance` inline em tesouraria. Nenhuma
 * filtra por `reconciled` e todas agregam TODAS as contas ativas, não uma. Este
 * arquivo é o lugar natural para unificá-las, mas isso muda os números de
 * Tesouraria, Fluxo de Caixa, Relatórios e do painel — PR próprio, com testes
 * de regressão das skills.
 */

import type { BankAccount, BankTransaction, ID } from "./entities";
import type { ISODate } from "./dates";

/** Nomes na convenção do app; o comentário dá o de-para com a especificação. */
export interface BankPeriodBalance {
  /** conta_id */
  bankAccountId: ID;
  /** saldo_inicial */
  openingBalanceCents: number;
  /** total_entradas — em módulo, nunca negativo */
  inflowCents: number;
  /** qtd_entradas */
  inflowCount: number;
  /** total_saidas — em módulo, nunca negativo */
  outflowCents: number;
  /** qtd_saidas */
  outflowCount: number;
  /** saldo */
  balanceCents: number;
  /** qtd_entradas + qtd_saidas, para a linha de total da tela. */
  reconciledCount: number;
}

export interface BankBalancePeriod {
  /** Inclusiva. */
  from: ISODate;
  /** Inclusiva. */
  to: ISODate;
}

/**
 * Só entram lançamentos DA CONTA, CONCILIADOS e DENTRO do período (limites
 * inclusivos nas duas pontas). Sem lançamentos, o saldo é o saldo inicial.
 *
 * `openingBalanceDate` não participa: a fórmula soma o saldo inicial qualquer
 * que seja o período pedido. É o comportamento especificado — e o mesmo que as
 * demais leituras de saldo do app já fazem.
 */
export function computeBankPeriodBalance(
  account: Pick<BankAccount, "id" | "openingBalanceCents">,
  transactions: readonly BankTransaction[],
  period: BankBalancePeriod
): BankPeriodBalance {
  let inflowCents = 0;
  let inflowCount = 0;
  let outflowCents = 0;
  let outflowCount = 0;

  for (const tx of transactions) {
    if (tx.bankAccountId !== account.id) continue;
    if (!tx.reconciled) continue;
    // ISODate é "YYYY-MM-DD": a comparação lexicográfica é a cronológica.
    if (tx.date < period.from || tx.date > period.to) continue;

    if (tx.amountCents > 0) {
      inflowCents += tx.amountCents;
      inflowCount += 1;
    } else if (tx.amountCents < 0) {
      outflowCents += Math.abs(tx.amountCents);
      outflowCount += 1;
    }
    // Valor zero não é entrada nem saída: não move saldo e não é lançamento a
    // contar de nenhum dos dois lados.
  }

  return {
    bankAccountId: account.id,
    openingBalanceCents: account.openingBalanceCents,
    inflowCents,
    inflowCount,
    outflowCents,
    outflowCount,
    balanceCents: account.openingBalanceCents + inflowCents - outflowCents,
    reconciledCount: inflowCount + outflowCount,
  };
}
