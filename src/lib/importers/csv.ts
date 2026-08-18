/**
 * Parser de extrato bancário em CSV.
 * - Detecta separador (";" ou ",") pela primeira linha não vazia;
 * - aceita cabeçalhos em pt-BR e inglês (data/date, descrição/histórico/description,
 *   valor/amount, e opcional id/documento);
 * - datas "DD/MM/YYYY" ou "YYYY-MM-DD"; valores "1.234,56", "-1234.56", "R$ 1.234,56";
 * - campos entre aspas podem conter o separador e aspas escapadas ("");
 * - linhas inválidas viram warnings — nunca explodem.
 */

import { isISODate, type ISODate } from "@/core/dates";
import {
  normalizeText,
  parseLocalizedAmountToCents,
  type ParsedStatement,
  type StatementTransaction,
} from "./common";

export type CsvSeparator = ";" | ",";

function detectSeparator(content: string): CsvSeparator {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return semicolons >= commas ? ";" : ",";
}

/**
 * CSV genérico → matriz de células (reutilizável por outros importadores).
 * Suporta aspas duplas com separador interno e aspas escapadas (""), CRLF/LF.
 */
export function parseCsv(content: string, separator?: CsvSeparator): string[][] {
  const sep = separator ?? detectSeparator(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Linhas totalmente vazias são descartadas.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function parseFlexibleDate(raw: string): ISODate | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isISODate(t) ? t : null;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (br) {
    const iso = `${br[3]}-${br[2]}-${br[1]}`;
    return isISODate(iso) ? iso : null;
  }
  return null;
}

interface ColumnSpec {
  exact: string[];
  contains: string[];
}

const DATE_COLUMN: ColumnSpec = { exact: ["data", "date"], contains: ["data", "date"] };
const DESCRIPTION_COLUMN: ColumnSpec = {
  exact: ["descricao", "description", "historico", "memo", "lancamento"],
  contains: ["desc", "histor"],
};
const AMOUNT_COLUMN: ColumnSpec = {
  exact: ["valor", "amount", "montante"],
  contains: ["valor", "amount"],
};
const ID_COLUMN: ColumnSpec = {
  exact: ["id", "documento", "doc", "fitid", "identificador"],
  contains: ["document", "fitid"],
};

function findColumn(header: string[], spec: ColumnSpec): number {
  const exactIdx = header.findIndex((h) => spec.exact.includes(h));
  if (exactIdx >= 0) return exactIdx;
  return header.findIndex((h) => spec.contains.some((c) => h.includes(c)));
}

export function parseCsvStatement(content: string): ParsedStatement {
  const warnings: string[] = [];
  const transactions: StatementTransaction[] = [];
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return { transactions, warnings: ["Arquivo CSV vazio."] };
  }

  const header = rows[0].map((h) => normalizeText(h));
  const dateIdx = findColumn(header, DATE_COLUMN);
  const descriptionIdx = findColumn(header, DESCRIPTION_COLUMN);
  const amountIdx = findColumn(header, AMOUNT_COLUMN);
  const idIdx = findColumn(header, ID_COLUMN);

  if (dateIdx < 0 || descriptionIdx < 0 || amountIdx < 0) {
    warnings.push(
      `Cabeçalho não reconhecido: são necessárias colunas de data, descrição/histórico e valor (recebido: ${rows[0].join(" | ")}).`
    );
    return { transactions, warnings };
  }

  for (let i = 1; i < rows.length; i++) {
    const line = i + 1; // 1-based, contando o cabeçalho
    const row = rows[i];
    const rawDate = row[dateIdx] ?? "";
    const rawAmount = row[amountIdx] ?? "";
    const date = parseFlexibleDate(rawDate);
    if (!date) {
      warnings.push(`Linha ${line} ignorada: data inválida ("${rawDate.trim()}").`);
      continue;
    }
    const amountCents = parseLocalizedAmountToCents(rawAmount);
    if (amountCents === null) {
      warnings.push(`Linha ${line} ignorada: valor inválido ("${rawAmount.trim()}").`);
      continue;
    }
    const fitid = idIdx >= 0 ? (row[idIdx] ?? "").trim() : "";
    transactions.push({
      date,
      amountCents,
      description: (row[descriptionIdx] ?? "").trim(),
      fitid: fitid || undefined,
    });
  }

  return { transactions, warnings };
}
