/**
 * Parser do CSV simples de orçamento colado no formulário.
 * Formato documentado na página: uma linha por categoria e mês:
 *   categoriaId;YYYY-MM;valor_em_reais
 * Aceita: comentários (#), linhas vazias, separador ";" ou TAB, período "MM/YYYY",
 * valores "1.234,56", "1234.56", "R$ 2.500,00". Módulo puro (testável em Node).
 */

export interface ParsedBudgetLine {
  period: string; // YYYY-MM
  categoryId: string;
  amountCents: number;
}

export interface BudgetCsvResult {
  lines: ParsedBudgetLine[];
  errors: string[];
}

/**
 * Converte texto monetário pt-BR (ou en) para centavos inteiros.
 * Regra do separador decimal: com ambos os separadores presentes, o último é o
 * decimal; um único separador seguido de 1–2 dígitos é decimal; caso contrário
 * é milhar. Retorna null se inválido.
 */
export function parseMoneyToCents(raw: string): number | null {
  const cleaned = raw.replace(/[Rr]\$/g, "").replace(/\s/g, "");
  if (cleaned.length === 0) return null;
  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  if (!/^[0-9.,]+$/.test(body) || !/[0-9]/.test(body)) return null;

  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");
  const sepIdx = Math.max(lastComma, lastDot);

  let intPart: string;
  let fracPart = "";
  if (sepIdx === -1) {
    intPart = body;
  } else {
    const after = body.slice(sepIdx + 1);
    const sepChar = body[sepIdx];
    const sepCount = body.split(sepChar).length - 1;
    const bothPresent = lastComma !== -1 && lastDot !== -1;
    // Decimal quando ambos os separadores aparecem ("1.234,56") ou quando há um
    // único separador seguido de 1–2 dígitos ("12,5" / "1234.56").
    // Caso contrário, separador de milhar ("1.234" / "1.234.567").
    const isDecimal =
      bothPresent || (sepCount === 1 && after.length >= 1 && after.length <= 2);
    if (isDecimal) {
      intPart = body.slice(0, sepIdx);
      fracPart = after;
    } else {
      // Separador de milhar: cada grupo após o primeiro deve ter 3 dígitos,
      // senão a entrada é ambígua/malformada ("2.500.00" ≠ 250.000).
      const groups = body.split(sepChar);
      const wellFormed =
        /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
      if (!wellFormed) return null;
      intPart = body;
    }
  }

  const digitsInt = intPart.replace(/[.,]/g, "");
  if (!/^\d*$/.test(digitsInt) || !/^\d*$/.test(fracPart)) return null;
  if (fracPart.length > 2) return null;
  const intVal = digitsInt.length > 0 ? Number.parseInt(digitsInt, 10) : 0;
  const fracVal = fracPart.length === 0 ? 0 : Number.parseInt(fracPart.padEnd(2, "0"), 10);
  if (!Number.isFinite(intVal) || !Number.isFinite(fracVal)) return null;
  const cents = intVal * 100 + fracVal;
  return negative ? -cents : cents;
}

const PERIOD_ISO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIOD_BR_RE = /^(0?[1-9]|1[0-2])\/(\d{4})$/;

/** Normaliza "2026-08" ou "8/2026" para "YYYY-MM"; null se inválido. */
export function normalizePeriod(raw: string): string | null {
  const s = raw.trim();
  if (PERIOD_ISO_RE.test(s)) return s;
  const br = PERIOD_BR_RE.exec(s);
  if (br) return `${br[2]}-${br[1].padStart(2, "0")}`;
  return null;
}

export function parseBudgetCsv(text: string): BudgetCsvResult {
  const errors: string[] = [];
  // Chave natural categoria+mês: duplicatas são somadas (documentado na página).
  const byKey = new Map<string, ParsedBudgetLine>();

  const rows = text.split(/\r?\n/);
  rows.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) return;

    const parts = line.split(/[;\t]/).map((p) => p.trim());
    if (parts.length !== 3) {
      errors.push(
        `Linha ${lineNo}: esperado 3 campos "categoriaId;YYYY-MM;valor" — recebido ${parts.length}.`
      );
      return;
    }
    const [categoryId, rawPeriod, rawAmount] = parts;
    if (categoryId.length === 0) {
      errors.push(`Linha ${lineNo}: categoriaId vazio.`);
      return;
    }
    const period = normalizePeriod(rawPeriod);
    if (!period) {
      errors.push(`Linha ${lineNo}: período inválido "${rawPeriod}" (use YYYY-MM).`);
      return;
    }
    const amountCents = parseMoneyToCents(rawAmount);
    if (amountCents === null) {
      errors.push(`Linha ${lineNo}: valor inválido "${rawAmount}".`);
      return;
    }
    if (amountCents < 0) {
      errors.push(`Linha ${lineNo}: valor negativo não é permitido em orçamento.`);
      return;
    }

    const key = `${categoryId}|${period}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.amountCents += amountCents;
    } else {
      byKey.set(key, { period, categoryId, amountCents });
    }
  });

  return { lines: [...byKey.values()], errors };
}
