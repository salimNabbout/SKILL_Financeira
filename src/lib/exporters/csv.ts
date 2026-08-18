/**
 * Exportador CSV no padrão brasileiro para Excel:
 * separador ";", quebras CRLF, BOM UTF-8 e decimais com vírgula.
 */

export interface CsvColumn {
  key: string;
  label: string;
}

const BOM = "\uFEFF";
const SEPARATOR = ";";
const LINE_BREAK = "\r\n";

/** Converte um valor de célula para texto (null/undefined viram vazio). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    // Excel pt-BR espera vírgula como separador decimal; inteiros ficam como estão.
    return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
  }
  if (typeof value === "boolean") return value ? "verdadeiro" : "falso";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Aplica aspas quando o valor contém separador, aspas ou quebra de linha. */
function escapeCell(text: string): string {
  if (text.includes('"') || text.includes(SEPARATOR) || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Gera CSV a partir de linhas homogêneas. Sem `columns`, as colunas são
 * inferidas das chaves da primeira linha (rótulo = chave).
 */
export function toCsv(
  rows: Array<Record<string, unknown>>,
  columns?: Array<{ key: string; label: string }>
): string {
  const cols: CsvColumn[] =
    columns ?? (rows.length > 0 ? Object.keys(rows[0]).map((key) => ({ key, label: key })) : []);

  const lines: string[] = [];
  if (cols.length > 0) {
    lines.push(cols.map((c) => escapeCell(c.label)).join(SEPARATOR));
  }
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(cellText(row[c.key]))).join(SEPARATOR));
  }

  return BOM + lines.join(LINE_BREAK) + (lines.length > 0 ? LINE_BREAK : "");
}
