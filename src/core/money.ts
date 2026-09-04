/**
 * Dinheiro como inteiro de centavos + código de moeda.
 * BRL por padrão; estrutura pronta para outras moedas.
 * Nunca usar float para valores monetários.
 */

// `import type` (apagado na compilação) — evita ciclo em runtime com entities,
// que por sua vez importa CurrencyCode daqui.
import type { Payable, Receivable } from "./entities";

export type CurrencyCode = "BRL" | "USD" | "EUR";

/**
 * Saldo em aberto de um título a pagar, em centavos.
 *
 * Clampado em 0 (`Math.max`): saldo negativo não tem significado de domínio.
 * Se `paidCents > amountCents` houve pagamento a maior — um caso de auditoria,
 * não um número para propagar em somas de saldo. Fluxos que precisem detectar
 * pagamento a maior devem comparar os campos diretamente, não usar este helper.
 */
export function payableRemainingCents(p: Payable): number {
  return Math.max(0, p.amountCents - p.paidCents);
}

/**
 * Saldo em aberto de um título a receber, em centavos.
 *
 * Usa `receivedCents` (Receivable não tem `paidCents`). Clampado em 0 pela
 * mesma razão de `payableRemainingCents`: saldo negativo (recebido a maior) é
 * caso de auditoria, não valor a propagar em somas.
 */
export function receivableRemainingCents(r: Receivable): number {
  return Math.max(0, r.amountCents - r.receivedCents);
}

export interface Money {
  amountCents: number;
  currency: CurrencyCode;
}

export function brl(amountCents: number): Money {
  return { amountCents: Math.round(amountCents), currency: "BRL" };
}

export function addCents(a: number, b: number): number {
  return a + b;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Moedas incompatíveis: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountCents: a.amountCents + b.amountCents, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountCents: a.amountCents - b.amountCents, currency: a.currency };
}

/** Percentual com arredondamento half-up em centavos. Ex.: pct(10000, 2) = 200. */
export function percentOf(amountCents: number, percent: number): number {
  return Math.round((amountCents * percent) / 100);
}

/**
 * Divide um valor em N parcelas somando exatamente o total
 * (resto distribuído nas primeiras parcelas).
 */
export function splitInstallments(totalCents: number, count: number): number[] {
  if (count < 1 || !Number.isInteger(count)) {
    throw new Error(`Número de parcelas inválido: ${count}`);
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

/** Formata centavos como moeda pt-BR. formatBRL(123456) => "R$ 1.234,56" */
export function formatBRL(amountCents: number): string {
  return BRL_FORMATTER.format(amountCents / 100);
}

export function formatMoney(m: Money): string {
  if (m.currency === "BRL") return formatBRL(m.amountCents);
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: m.currency }).format(
    m.amountCents / 100
  );
}

/**
 * Juros e multa por atraso — regra determinística, parâmetros vêm de
 * configuração da empresa (nunca hardcode de regra tributária).
 * Fórmula: multa = principal * finePercent;
 *          juros = principal * (monthlyInterestPercent/30) * diasAtraso.
 */
export interface LateFeePolicy {
  finePercent: number; // ex.: 2 = 2%
  monthlyInterestPercent: number; // ex.: 1 = 1% a.m. (pro rata die)
}

export interface LateFeeResult {
  fineCents: number;
  interestCents: number;
  totalCents: number; // principal + multa + juros
  daysLate: number;
  formula: string;
}

export function computeLateFee(
  principalCents: number,
  daysLate: number,
  policy: LateFeePolicy
): LateFeeResult {
  const days = Math.max(0, daysLate);
  const fineCents = days > 0 ? percentOf(principalCents, policy.finePercent) : 0;
  const interestCents =
    days > 0
      ? Math.round((principalCents * (policy.monthlyInterestPercent / 100) * days) / 30)
      : 0;
  return {
    fineCents,
    interestCents,
    totalCents: principalCents + fineCents + interestCents,
    daysLate: days,
    formula: `total = principal + principal×${policy.finePercent}% + principal×(${policy.monthlyInterestPercent}%/30)×${days} dias`,
  };
}

/**
 * Recebimento que ainda vale — os estornados (`status: "canceled"`) saem de
 * TODA conta: saldo do título, orçamento, DSO, contabilidade e relatórios.
 * Linhas anteriores ao estorno existir não têm status e valem.
 */
export function receiptIsActive(receipt: { status?: string }): boolean {
  return receipt.status !== "canceled";
}
