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

/**
 * Converte um valor de célula para texto (null/undefined viram vazio).
 * O flag `formulaSafe` indica que o texto provém de um número/booleano/data
 * gerado por nós — nunca deve receber o apóstrofo-guarda de anti-injeção.
 */
function cellText(value: unknown): { text: string; formulaSafe: boolean } {
  if (value === null || value === undefined) return { text: "", formulaSafe: true };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { text: "", formulaSafe: true };
    // Excel pt-BR espera vírgula como separador decimal; inteiros ficam como estão.
    return {
      text: Number.isInteger(value) ? String(value) : String(value).replace(".", ","),
      formulaSafe: true,
    };
  }
  if (typeof value === "boolean") return { text: value ? "verdadeiro" : "falso", formulaSafe: true };
  if (value instanceof Date) return { text: value.toISOString(), formulaSafe: true };
  if (typeof value === "object") return { text: JSON.stringify(value), formulaSafe: false };
  return { text: String(value), formulaSafe: false };
}

// Caracteres que o Excel/Sheets interpretam como início de fórmula.
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Neutraliza injeção de fórmula CSV: um texto que começa com =, +, -, @, tab ou
 * CR recebe um apóstrofo-guarda, fazendo a planilha tratá-lo como texto literal.
 * Não se aplica a valores numéricos gerados internamente (ex.: -0,5).
 */
function neutralizeFormula(text: string): string {
  if (text.length > 0 && FORMULA_TRIGGERS.has(text[0])) {
    return `'${text}`;
  }
  return text;
}

/** Aplica aspas quando o valor contém separador, aspas ou quebra de linha. */
function escapeCell(text: string): string {
  if (text.includes('"') || text.includes(SEPARATOR) || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Texto final da célula: neutraliza fórmula (só texto de origem) e escapa. */
function renderCell(value: unknown): string {
  const { text, formulaSafe } = cellText(value);
  return escapeCell(formulaSafe ? text : neutralizeFormula(text));
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
    lines.push(cols.map((c) => escapeCell(neutralizeFormula(c.label))).join(SEPARATOR));
  }
  for (const row of rows) {
    lines.push(cols.map((c) => renderCell(row[c.key])).join(SEPARATOR));
  }

  return BOM + lines.join(LINE_BREAK) + (lines.length > 0 ? LINE_BREAK : "");
}
