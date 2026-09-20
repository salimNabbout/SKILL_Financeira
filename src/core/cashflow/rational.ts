/**
 * Aritmética racional exata (BigInt) para as fórmulas da projeção.
 *
 * A planilha guarda médias como 75.333,333… e só arredonda na célula; se o app
 * arredondasse cada mês em centavos, o saldo de 12 meses derivaria alguns
 * centavos (−20.879,96 em vez de −20.880,00 no dataset de referência). Aqui o
 * cálculo é feito em frações n/d e o arredondamento para centavos acontece
 * uma única vez, na saída — "arredondamento apenas na apresentação".
 */

export interface Rational {
  n: bigint;
  d: bigint; // sempre > 0
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rat(n: bigint | number, d: bigint | number = 1n): Rational {
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new Error("Rational: denominador zero");
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd) || 1n;
  return { n: nn / g, d: dd / g };
}

export const ZERO: Rational = { n: 0n, d: 1n };

export function add(a: Rational, b: Rational): Rational {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function sub(a: Rational, b: Rational): Rational {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}
export function mul(a: Rational, b: Rational): Rational {
  return rat(a.n * b.n, a.d * b.d);
}
/** Compara a e b: negativo se a < b, zero se iguais, positivo se a > b. */
export function cmp(a: Rational, b: Rational): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
export function fromCents(cents: number): Rational {
  return rat(BigInt(Math.trunc(cents)), 1n);
}
/** (base + bp) / 10000 — fator de ajuste em pontos-base (1% = 100). */
export function bpFactor(bp: number): Rational {
  return rat(10_000n + BigInt(Math.trunc(bp)), 10_000n);
}
export function pow(a: Rational, exp: number): Rational {
  let result: Rational = { n: 1n, d: 1n };
  for (let i = 0; i < exp; i++) result = mul(result, a);
  return result;
}
/** Centavos inteiros, meia unidade arredondada para longe de zero (como a planilha). */
export function toCents(a: Rational): number {
  const neg = a.n < 0n;
  const n = neg ? -a.n : a.n;
  const q = n / a.d;
  const r = n % a.d;
  const rounded = r * 2n >= a.d ? q + 1n : q;
  return Number(neg ? -rounded : rounded);
}
