/**
 * Saldo de uma conta bancária num período.
 *
 *   SALDO = SALDO_INICIAL + TOTAL_ENTRADAS − TOTAL_SAIDAS
 *
 * O dinheiro conciliado aparece em DOIS lugares do sistema, e a primeira versão
 * desta função olhava só para um deles — o que fazia o saldo nunca sair do
 * lugar:
 *
 * - **Registro da empresa**: `Payment` executado (saída) e `Receipt` (entrada).
 *   É o que a tela de Conciliação chama de "Conciliados". Conciliar um
 *   pagamento ali NÃO cria transação bancária nenhuma.
 * - **Extrato do banco**: `BankTransaction` com `reconciled = true`, que só
 *   acontece pela conciliação de extrato importado.
 *
 * Somar os dois às cegas contaria o mesmo dinheiro duas vezes quando uma
 * transação do extrato é casada com um pagamento. Por isso a transação só entra
 * quando NÃO está casada com algo já contado — o que sobra é justamente o que o
 * registro da empresa não enxerga: tarifa, IOF, juros do banco, transferência.
 *
 * As linhas são a fonte única: os totais derivam delas. A tela lista exatamente
 * as mesmas linhas, então lista e número não têm como divergir.
 *
 * Convenções mantidas da especificação: entradas e saídas saem em MÓDULO (o
 * sinal é da fórmula), limites do período inclusivos, e o saldo inicial entra
 * por inteiro qualquer que seja o período.
 *
 * DÍVIDA REGISTRADA: existem três outras somas de saldo no app — `loadCashBase`
 * (tesouraria), `loadBankBase` (relatorios) e um `startingBalance` inline. Todas
 * agregam TODAS as contas e ignoram conciliação. Unificar muda os números de
 * Tesouraria, Fluxo de Caixa, Relatórios e do painel: PR próprio.
 */

import { todayInTz, type ISODate } from "./dates";
import type {
  BankAccount,
  BankTransaction,
  ID,
  Payment,
  Receipt,
  ReconciliationMatch,
} from "./entities";
import { receiptIsActive } from "./money";

export type BalanceLineOrigin = "payment" | "receipt" | "bank";

/** Uma movimentação que entra na conta do saldo. */
export interface BalanceLine {
  origin: BalanceLineOrigin;
  /** id do Payment, Receipt ou BankTransaction — a tela resolve o rótulo. */
  sourceId: ID;
  date: ISODate;
  /** ASSINADO: positivo entra, negativo sai. */
  amountCents: number;
}

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
  /** qtd_entradas + qtd_saidas */
  reconciledCount: number;
}

export interface BankBalancePeriod {
  /** Inclusiva. */
  from: ISODate;
  /** Inclusiva. */
  to: ISODate;
}

export interface BankBalanceInput {
  account: Pick<BankAccount, "id" | "openingBalanceCents">;
  payments: readonly Payment[];
  receipts: readonly Receipt[];
  transactions: readonly BankTransaction[];
  /** Para não contar duas vezes o que já veio como pagamento/recebimento. */
  matches: readonly ReconciliationMatch[];
  period: BankBalancePeriod;
  /**
   * Fuso da empresa: `Payment.executedAt` é timestamp, não data. Converter em
   * UTC faria um pagamento do fim da tarde cair no dia seguinte.
   */
  timeZone: string;
}

/** Alvos cujo dinheiro JÁ é contado pelo registro da empresa. */
const ALVOS_JA_CONTADOS = new Set(["payment", "receipt", "payable", "receivable"]);

function dentro(date: ISODate, period: BankBalancePeriod): boolean {
  // ISODate é "YYYY-MM-DD": a comparação lexicográfica é a cronológica.
  return date >= period.from && date <= period.to;
}

/**
 * As movimentações do período, ordenadas por data. Fonte única: os totais de
 * `computeBankPeriodBalance` são somas destas linhas.
 */
export function balanceLines(input: BankBalanceInput): BalanceLine[] {
  const { account, period } = input;
  const linhas: BalanceLine[] = [];

  // Saídas: pagamento executado. Cancelado/estornado sai de "executed" e some
  // daqui sozinho, mesmo mantendo o executedAt no registro.
  for (const p of input.payments) {
    if (p.bankAccountId !== account.id) continue;
    if (p.status !== "executed" || !p.executedAt) continue;
    const date = todayInTz(new Date(p.executedAt), input.timeZone);
    if (!dentro(date, period)) continue;
    linhas.push({ origin: "payment", sourceId: p.id, date, amountCents: -p.amountCents });
  }

  // Entradas: recebimento ativo. `amountCents` é o que entrou no banco — inclui
  // multa e juros, ao contrário de principalCents, que só baixa o título.
  // Recibo sem bankAccountId fica de fora: não há como atribuí-lo a uma conta.
  for (const r of input.receipts) {
    if (r.bankAccountId !== account.id) continue;
    if (!receiptIsActive(r)) continue;
    if (!dentro(r.receivedDate, period)) continue;
    linhas.push({
      origin: "receipt",
      sourceId: r.id,
      date: r.receivedDate,
      amountCents: r.amountCents,
    });
  }

  // Extrato: só o que o registro da empresa NÃO enxerga — tarifa, IOF, juros do
  // banco, transferência. O que foi casado com pagamento/recebimento/título já
  // entrou acima e contaria em dobro.
  const casadaComAlgoJaContado = new Set(
    input.matches
      .filter(
        (m) =>
          (m.status === "confirmed" || m.status === "auto_confirmed") &&
          ALVOS_JA_CONTADOS.has(m.targetType)
      )
      .map((m) => m.bankTransactionId)
  );

  for (const tx of input.transactions) {
    if (tx.bankAccountId !== account.id) continue;
    if (!tx.reconciled) continue;
    if (!dentro(tx.date, period)) continue;
    if (casadaComAlgoJaContado.has(tx.id)) continue;
    linhas.push({
      origin: "bank",
      sourceId: tx.id,
      date: tx.date,
      amountCents: tx.amountCents,
    });
  }

  return linhas.sort((a, b) =>
    a.date === b.date ? a.sourceId.localeCompare(b.sourceId) : a.date.localeCompare(b.date)
  );
}

/**
 * Sem movimentação no período, o saldo é o saldo inicial.
 *
 * `openingBalanceDate` não participa: a fórmula soma o saldo inicial qualquer
 * que seja o período pedido. É o comportamento especificado.
 */
export function computeBankPeriodBalance(input: BankBalanceInput): BankPeriodBalance {
  let inflowCents = 0;
  let inflowCount = 0;
  let outflowCents = 0;
  let outflowCount = 0;

  for (const linha of balanceLines(input)) {
    if (linha.amountCents > 0) {
      inflowCents += linha.amountCents;
      inflowCount += 1;
    } else if (linha.amountCents < 0) {
      outflowCents += Math.abs(linha.amountCents);
      outflowCount += 1;
    }
    // Valor zero não é entrada nem saída: não move saldo e não conta de
    // nenhum dos dois lados.
  }

  return {
    bankAccountId: input.account.id,
    openingBalanceCents: input.account.openingBalanceCents,
    inflowCents,
    inflowCount,
    outflowCents,
    outflowCount,
    balanceCents: input.account.openingBalanceCents + inflowCents - outflowCents,
    reconciledCount: inflowCount + outflowCount,
  };
}
