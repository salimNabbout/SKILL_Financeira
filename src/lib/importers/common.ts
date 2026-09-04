/**
 * Tipos e utilitários compartilhados pelos importadores de extrato bancário.
 * Funções puras: sem repositórios, relógio ou I/O — 100% testáveis isoladamente.
 */

import type { ISODate } from "@/core/dates";

/** Transação de extrato já normalizada (dinheiro em CENTAVOS, data ISODate). */
export interface StatementTransaction {
  date: ISODate;
  amountCents: number;
  description: string;
  fitid?: string;
}

export interface ParsedStatement {
  transactions: StatementTransaction[];
  accountId?: string;
  warnings: string[];
  /**
   * Saldo que o BANCO declara no arquivo, na data-base dele. Só o OFX traz
   * (`<LEDGERBAL>`); CSV e CNAB240 não têm o campo. É a única referência
   * externa para conferir o saldo calculado pelo app — por isso é guardado no
   * lote de importação em vez de descartado.
   */
  ledgerBalance?: { amountCents: number; date: ISODate };
}

/** Remove acentos, baixa caixa e apara — para comparação de cabeçalhos/descrições. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// Limite de dígitos inteiros para manter o resultado dentro de Number.isSafeInteger
// (13 dígitos de reais => até ~R$ 9,9 trilhões em centavos).
const MAX_INT_DIGITS = 13;

/**
 * Converte partes decimais (string) em centavos SEM passar por float:
 * centavos = inteiro*100 + 2 primeiros dígitos da fração; o 3º dígito
 * decimal, quando presente, arredonda meio-para-cima (sobre o valor absoluto).
 */
function centsFromParts(negative: boolean, intDigits: string, fracDigits: string): number | null {
  if (!/^\d*$/.test(intDigits) || !/^\d*$/.test(fracDigits)) return null;
  if (intDigits === "" && fracDigits === "") return null;
  if (intDigits.length > MAX_INT_DIGITS) return null;
  const frac2 = (fracDigits + "00").slice(0, 2);
  let cents = Number(intDigits || "0") * 100 + Number(frac2);
  if (fracDigits.length > 2 && fracDigits.charCodeAt(2) >= 53 /* '5' */) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Parser para valores OFX: o separador ("." ou ",") é SEMPRE decimal — o
 * padrão OFX não usa separador de milhar. Ex.: "-250.75" => -25075; "1,5" => 150.
 * Retorna null para entrada inválida (o chamador decide gerar warning).
 */
export function parseDecimalToCents(raw: string): number | null {
  const m = /^([+-]?)(\d+)(?:[.,](\d+))?$/.exec(raw.trim());
  if (!m) return null;
  return centsFromParts(m[1] === "-", m[2], m[3] ?? "");
}

/**
 * Parser para valores de CSV bancário: aceita "R$ 1.234,56", "1.234,56",
 * "-1234.56", "1,234.56", "1500", com sinal. Heurística documentada:
 * - com os dois separadores, o que aparece por último é o decimal;
 * - com um único separador, grupos exatos de 3 dígitos ("1.234", "12.345.678")
 *   são tratados como separador de milhar; caso contrário, decimal.
 */
export function parseLocalizedAmountToCents(raw: string): number | null {
  let t = raw.replace(/R\$/gi, "").replace(/[\s ]/g, "");
  if (!t) return null;
  let negative = false;
  // Parênteses contábeis: "(1.234,56)" = negativo.
  if (t.startsWith("(") && t.endsWith(")")) {
    negative = true;
    t = t.slice(1, -1);
  }
  // Sinal ao final (extratos legados): "150,00-" / "150,00+".
  if (t.endsWith("-")) {
    if (negative) return null; // sinal duplicado
    negative = true;
    t = t.slice(0, -1);
  } else if (t.endsWith("+")) {
    t = t.slice(0, -1);
  }
  if (t.startsWith("-")) {
    if (negative) return null; // sinal duplicado ("-150,00-")
    negative = true;
    t = t.slice(1);
  } else if (t.startsWith("+")) {
    t = t.slice(1);
  }
  const hasComma = t.includes(",");
  const hasDot = t.includes(".");
  let intPart = t;
  let fracPart = "";
  if (hasComma && hasDot) {
    const dec = t.lastIndexOf(",") > t.lastIndexOf(".") ? "," : ".";
    const thou = dec === "," ? "." : ",";
    const cleaned = t.split(thou).join("");
    const idx = cleaned.lastIndexOf(dec);
    if (cleaned.indexOf(dec) !== idx) return null; // dois separadores decimais
    intPart = cleaned.slice(0, idx);
    fracPart = cleaned.slice(idx + 1);
  } else if (hasComma || hasDot) {
    const sep = hasComma ? "," : ".";
    const thousandsRe = sep === "," ? /^\d{1,3}(,\d{3})+$/ : /^\d{1,3}(\.\d{3})+$/;
    if (thousandsRe.test(t)) {
      intPart = t.split(sep).join("");
    } else {
      const idx = t.lastIndexOf(sep);
      if (t.indexOf(sep) !== idx) return null;
      intPart = t.slice(0, idx);
      fracPart = t.slice(idx + 1);
    }
  }
  return centsFromParts(negative, intPart, fracPart);
}
