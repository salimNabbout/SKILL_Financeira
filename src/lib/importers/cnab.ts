/**
 * CNAB240 — extrato eletrônico para conciliação (padrão FEBRABAN).
 *
 * Arquivo posicional com linhas de 240 caracteres:
 *   tipo 0 = header de arquivo · tipo 1 = header de lote · tipo 3 = detalhe ·
 *   tipo 5 = trailer de lote · tipo 9 = trailer de arquivo.
 * Para conciliação interessa o detalhe SEGMENTO E (lançamentos do extrato).
 *
 * Posições implementadas (1-based, FEBRABAN v10.7 — bancos publicam variantes;
 * ajustes por banco entram como configuração futura, ver docs/12):
 *   001-003 banco · 004-007 lote · 008 tipo registro · 009-013 sequencial ·
 *   014 segmento · 143-150 data do lançamento (DDMMAAAA) ·
 *   151-168 valor (18 dígitos, 2 decimais implícitos) · 169 D/C ·
 *   177-201 histórico · 202-240 complemento/documento.
 *
 * Tolerante: linhas malformadas viram warnings (nunca explodem o arquivo).
 */

import { isISODate, type ISODate } from "@/core/dates";
import type { ParsedStatement, StatementTransaction } from "./common";

/** Layout do segmento E (1-based, inclusivo) — exportado para os testes. */
export const CNAB240_LAYOUT = {
  bank: [1, 3],
  recordType: [8, 8],
  segment: [14, 14],
  date: [143, 150], // DDMMAAAA
  amount: [151, 168], // 18 dígitos, centavos implícitos
  debitCredit: [169, 169], // D | C
  history: [177, 201],
  complement: [202, 240],
} as const;

export const CNAB240_LINE_LENGTH = 240;

function slice1(line: string, [start, end]: readonly [number, number]): string {
  return line.slice(start - 1, end);
}

function parseCnabDate(raw: string): ISODate | null {
  const m = raw.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isISODate(iso) ? iso : null;
}

/** Detecção estrutural: linhas de 240 chars, banco numérico e tipo de registro válido. */
export function looksLikeCnab240(content: string): boolean {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const first = lines[0];
  return (
    first.length === CNAB240_LINE_LENGTH &&
    /^\d{3}$/.test(slice1(first, CNAB240_LAYOUT.bank)) &&
    /^[01359]$/.test(slice1(first, CNAB240_LAYOUT.recordType))
  );
}

export function parseCnab240(content: string): ParsedStatement {
  const warnings: string[] = [];
  const transactions: StatementTransaction[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim().length === 0) continue;
    if (line.length !== CNAB240_LINE_LENGTH) {
      warnings.push(
        `Linha ${i + 1} com ${line.length} caracteres (esperado ${CNAB240_LINE_LENGTH}) — ignorada.`
      );
      continue;
    }

    const recordType = slice1(line, CNAB240_LAYOUT.recordType);
    if (recordType !== "3") continue; // headers/trailers não geram lançamento
    const segment = slice1(line, CNAB240_LAYOUT.segment).toUpperCase();
    if (segment !== "E") {
      warnings.push(`Linha ${i + 1}: segmento "${segment}" ignorado (apenas E gera lançamento).`);
      continue;
    }

    const date = parseCnabDate(slice1(line, CNAB240_LAYOUT.date));
    if (!date) {
      warnings.push(`Linha ${i + 1}: data de lançamento inválida — ignorada.`);
      continue;
    }

    const amountRaw = slice1(line, CNAB240_LAYOUT.amount);
    if (!/^\d+$/.test(amountRaw)) {
      warnings.push(`Linha ${i + 1}: valor não numérico — ignorada.`);
      continue;
    }
    const cents = Number(amountRaw); // últimos 2 dígitos já são os centavos
    if (!Number.isSafeInteger(cents)) {
      warnings.push(`Linha ${i + 1}: valor fora do intervalo suportado — ignorada.`);
      continue;
    }

    const dc = slice1(line, CNAB240_LAYOUT.debitCredit).toUpperCase();
    if (dc !== "D" && dc !== "C") {
      warnings.push(`Linha ${i + 1}: natureza "${dc}" inválida (esperado D ou C) — ignorada.`);
      continue;
    }

    const history = slice1(line, CNAB240_LAYOUT.history).trim();
    const complement = slice1(line, CNAB240_LAYOUT.complement).trim();
    const description =
      [history, complement].filter((p) => p.length > 0).join(" ") || "LANCAMENTO CNAB240";

    transactions.push({
      date,
      amountCents: dc === "D" ? -cents : cents,
      description,
      // Sem FITID no CNAB240: a deduplicação usa o hash determinístico da skill.
    });
  }

  if (transactions.length === 0 && warnings.length === 0) {
    warnings.push("Nenhum detalhe segmento E encontrado no arquivo CNAB240.");
  }
  return { transactions, warnings };
}

/** Alias mantido pelo contrato original dos importadores. */
export const parseCnab = parseCnab240;
