/**
 * Layouts de exportação contábil como DADOS declarativos — mesma filosofia das
 * regras tributárias: nada de formato fixo em código espalhado.
 *
 * IMPORTANTE: os layouts "dominio", "omie" e "contmatic" são LAYOUTS DE
 * REFERÊNCIA — aproximações dos formatos de importação de lançamentos desses
 * sistemas. Cada instalação tem variantes (códigos de conta, histórico padrão,
 * campos opcionais); o contador DEVE validar um lote de teste antes do primeiro
 * uso real e ajustes por instalação entram como novos layouts declarativos.
 */

import type { AccountingEntry } from "@/core/entities";
import type { ISODate } from "@/core/dates";

export const EXPORT_LAYOUT_IDS = ["padrao", "dominio", "omie", "contmatic"] as const;
export type ExportLayoutId = (typeof EXPORT_LAYOUT_IDS)[number];

/** Campo do lançamento que alimenta uma coluna do layout. */
export type LayoutColumnSource =
  | "entryDate"
  | "debitAccount"
  | "creditAccount"
  | "amount"
  | "memo"
  | "origin";

export interface LayoutColumn {
  header: string;
  source: LayoutColumnSource;
}

export interface AccountingExportLayout {
  id: ExportLayoutId;
  name: string;
  /** O que o layout aproxima + aviso de validação obrigatória pelo contador. */
  reference: string;
  separator: string;
  includeHeader: boolean;
  dateFormat: "iso" | "br";
  /**
   * Decimal do valor: "comma" (padrão BR, exige separador ≠ ",") ou "dot".
   * Invariante protegida por teste: separador "," implica decimal "dot".
   */
  amountFormat: "comma" | "dot";
  fileExtension: "csv" | "txt";
  columns: LayoutColumn[];
}

const FULL_COLUMNS: LayoutColumn[] = [
  { header: "data", source: "entryDate" },
  { header: "conta_debito", source: "debitAccount" },
  { header: "conta_credito", source: "creditAccount" },
  { header: "valor", source: "amount" },
  { header: "historico", source: "memo" },
  { header: "origem", source: "origin" },
];

export const EXPORT_LAYOUTS: Record<ExportLayoutId, AccountingExportLayout> = {
  padrao: {
    id: "padrao",
    name: "Padrão Financeira PME (CSV)",
    reference:
      "Layout próprio da plataforma: CSV com ';', datas ISO (YYYY-MM-DD) e vírgula decimal — importável por planilhas e sistemas genéricos.",
    separator: ";",
    includeHeader: true,
    dateFormat: "iso",
    amountFormat: "comma",
    fileExtension: "csv",
    columns: FULL_COLUMNS,
  },
  dominio: {
    id: "dominio",
    name: "Domínio Sistemas — referência (TXT)",
    reference:
      "LAYOUT DE REFERÊNCIA para importação de lançamentos no Domínio (Thomson Reuters): sem cabeçalho, ';', data DD/MM/AAAA, débito/crédito/valor/histórico. Códigos de conta e histórico padrão variam por instalação — valide um lote de teste com o contador antes do uso real.",
    separator: ";",
    includeHeader: false,
    dateFormat: "br",
    amountFormat: "comma",
    fileExtension: "txt",
    columns: [
      { header: "data", source: "entryDate" },
      { header: "conta_debito", source: "debitAccount" },
      { header: "conta_credito", source: "creditAccount" },
      { header: "valor", source: "amount" },
      { header: "historico", source: "memo" },
    ],
  },
  omie: {
    id: "omie",
    name: "Omie — referência (CSV)",
    reference:
      "LAYOUT DE REFERÊNCIA para importação no Omie: CSV com cabeçalho em português, ';', data DD/MM/AAAA. Valide um lote de teste com o contador antes do uso real.",
    separator: ";",
    includeHeader: true,
    dateFormat: "br",
    amountFormat: "comma",
    fileExtension: "csv",
    columns: [
      { header: "Data", source: "entryDate" },
      { header: "Conta Débito", source: "debitAccount" },
      { header: "Conta Crédito", source: "creditAccount" },
      { header: "Valor", source: "amount" },
      { header: "Histórico", source: "memo" },
      { header: "Origem", source: "origin" },
    ],
  },
  contmatic: {
    id: "contmatic",
    name: "Contmatic — referência (CSV)",
    reference:
      "LAYOUT DE REFERÊNCIA para importação no Contmatic: CSV sem cabeçalho, separador ',' com decimal em PONTO (evita colisão com o separador), data DD/MM/AAAA, histórico ao final. Valide um lote de teste com o contador antes do uso real.",
    separator: ",",
    includeHeader: false,
    dateFormat: "br",
    amountFormat: "dot",
    fileExtension: "csv",
    columns: [
      { header: "data", source: "entryDate" },
      { header: "conta_debito", source: "debitAccount" },
      { header: "conta_credito", source: "creditAccount" },
      { header: "valor", source: "amount" },
      { header: "historico", source: "memo" },
    ],
  },
};

/** Centavos → decimal: 123456 → "1234,56" (comma) ou "1234.56" (dot). */
function layoutAmount(cents: number, format: "comma" | "dot"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const decimal = format === "comma" ? "," : ".";
  return `${sign}${Math.floor(abs / 100)}${decimal}${String(abs % 100).padStart(2, "0")}`;
}

function layoutDate(date: ISODate, format: "iso" | "br"): string {
  if (format === "iso") return date;
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

/** Texto seguro para o layout: separador e quebras de linha viram espaço. */
function layoutText(text: string, separator: string): string {
  return text.split(separator).join(" ").replace(/[\r\n]+/g, " ").trim();
}

function columnValue(
  entry: AccountingEntry,
  source: LayoutColumnSource,
  layout: AccountingExportLayout
): string {
  switch (source) {
    case "entryDate":
      return layoutDate(entry.entryDate, layout.dateFormat);
    case "debitAccount":
      return entry.debitAccount;
    case "creditAccount":
      return entry.creditAccount;
    case "amount":
      return layoutAmount(entry.amountCents, layout.amountFormat);
    case "memo":
      return layoutText(entry.memo, layout.separator);
    case "origin":
      return `${entry.sourceType}:${entry.sourceId}`;
  }
}

/** Renderiza o lote (cabeçalho opcional + uma linha por lançamento). */
export function renderLayoutLines(
  layout: AccountingExportLayout,
  entries: AccountingEntry[]
): string[] {
  const lines: string[] = [];
  if (layout.includeHeader) {
    lines.push(layout.columns.map((c) => c.header).join(layout.separator));
  }
  for (const entry of entries) {
    lines.push(layout.columns.map((c) => columnValue(entry, c.source, layout)).join(layout.separator));
  }
  return lines;
}

/** Nome de arquivo determinístico do lote. */
export function layoutFilename(layout: AccountingExportLayout, period: string): string {
  return `lancamentos-${period}-${layout.id}.${layout.fileExtension}`;
}
