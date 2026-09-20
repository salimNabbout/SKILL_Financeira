/**
 * Leitor de .xlsx sem dependências externas — o inverso do exportador
 * (`src/lib/exporters/xlsx.ts`).
 *
 * Abre o pacote ZIP (métodos STORE e DEFLATE, via zlib do Node), localiza a
 * aba pelo nome em xl/workbook.xml + rels, resolve sharedStrings e devolve as
 * células com valor: números (inclusive datas, como número de série), textos
 * (inline, compartilhados ou resultado de fórmula), lógicos e erros.
 *
 * Fórmulas NÃO são avaliadas: vale o valor em cache gravado pelo Excel (ou
 * pelo nosso exportador). Sem ZIP64, sem criptografia, sem macros — o que
 * basta para reimportar a planilha que o próprio app gera e o usuário edita.
 */

import { inflateRawSync } from "node:zlib";

export interface XlsxCellData {
  type: "n" | "s" | "b" | "e";
  value: number | string | boolean;
}

export interface XlsxSheetData {
  name: string;
  /** Referência ("B2") → célula com valor. Células vazias não aparecem. */
  cells: Map<string, XlsxCellData>;
  maxRow: number;
}

export interface XlsxWorkbookData {
  sheetNames: string[];
  readSheet(name: string): XlsxSheetData | null;
}

export interface XlsxReadOptions {
  /** Teto por parte descompactada (proteção contra zip bomb). Padrão 64 MB. */
  maxEntryBytes?: number;
}

export class XlsxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxReadError";
  }
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipRecord {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function zipDirectory(buf: Buffer): Map<string, ZipRecord> {
  if (buf.length < 22) throw new XlsxReadError("Arquivo não é um .xlsx (pacote ZIP inválido).");
  // EOCD fica no fim; pode haver comentário (até 64 KB) depois dele.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxReadError("Arquivo não é um .xlsx (diretório ZIP não encontrado).");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipRecord>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new XlsxReadError("Arquivo .xlsx corrompido (diretório central inválido).");
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipExtract(buf: Buffer, rec: ZipRecord, maxBytes: number): Uint8Array {
  const p = rec.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
    throw new XlsxReadError("Arquivo .xlsx corrompido (cabeçalho local inválido).");
  }
  if (rec.size > maxBytes) throw new XlsxReadError("Parte do .xlsx grande demais para ser lida.");
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + rec.compressedSize);
  if (rec.method === 0) return data;
  if (rec.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new XlsxReadError(`Método de compressão ${rec.method} não suportado no .xlsx.`);
}

// ---------------------------------------------------------------------------
// XML mínimo (as partes do SpreadsheetML que interessam são regulares)
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]) : undefined;
}

/** Concatena todos os <t> (texto simples e rich text) de um trecho. */
function textRuns(xml: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += decodeEntities(m[1]);
  return out;
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(textRuns(m[1]));
  return out;
}

function parseSheetXml(name: string, xml: string, shared: string[]): XlsxSheetData {
  const cells = new Map<string, XlsxCellData>();
  let maxRow = 0;
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const inner = m[2] ?? "";
    const ref = attr(attrs, "r");
    if (!ref) continue;
    const type = attr(attrs, "t") ?? "n";
    const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
    const v = vMatch ? decodeEntities(vMatch[1]) : undefined;
    let cell: XlsxCellData | null = null;
    if (type === "inlineStr") {
      const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
      cell = { type: "s", value: is ? textRuns(is[1]) : "" };
    } else if (type === "s") {
      if (v !== undefined) cell = { type: "s", value: shared[Number(v)] ?? "" };
    } else if (type === "str") {
      cell = { type: "s", value: v ?? "" };
    } else if (type === "b") {
      if (v !== undefined) cell = { type: "b", value: v === "1" || v.toLowerCase() === "true" };
    } else if (type === "e") {
      cell = { type: "e", value: v ?? "#ERR" };
    } else if (v !== undefined && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) cell = { type: "n", value: n };
    }
    if (!cell) continue;
    if (cell.type === "s" && cell.value === "") continue;
    cells.set(ref.toUpperCase(), cell);
    const row = Number(/\d+$/.exec(ref)?.[0] ?? 0);
    if (row > maxRow) maxRow = row;
  }
  return { name, cells, maxRow };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function readXlsx(bytes: Uint8Array, opts: XlsxReadOptions = {}): XlsxWorkbookData {
  const maxBytes = opts.maxEntryBytes ?? 64 * 1024 * 1024;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dir = zipDirectory(buf);
  const text = (name: string): string | null => {
    const rec = dir.get(name);
    return rec ? Buffer.from(zipExtract(buf, rec, maxBytes)).toString("utf8") : null;
  };

  const workbookXml = text("xl/workbook.xml");
  if (!workbookXml) throw new XlsxReadError("Arquivo não é um .xlsx (xl/workbook.xml ausente).");
  const relsXml = text("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const rel of relsXml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets: Array<{ name: string; part: string }> = [];
  for (const tag of workbookXml.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = attr(tag, "name");
    const rid = attr(tag, "r:id") ?? attr(tag, "id");
    const part = rid ? targets.get(rid) : undefined;
    if (name && part) sheets.push({ name, part });
  }
  let shared: string[] | null = null;

  return {
    sheetNames: sheets.map((s) => s.name),
    readSheet(name: string): XlsxSheetData | null {
      const sheet = sheets.find((s) => s.name === name);
      if (!sheet) return null;
      const xml = text(sheet.part);
      if (!xml) return null;
      if (!shared) shared = parseSharedStrings(text("xl/sharedStrings.xml"));
      return parseSheetXml(sheet.name, xml, shared);
    },
  };
}

/** Linhas → (letra da coluna → célula), só as linhas com alguma célula. */
export function sheetRows(sheet: XlsxSheetData): Map<number, Map<string, XlsxCellData>> {
  const rows = new Map<number, Map<string, XlsxCellData>>();
  for (const [ref, cell] of sheet.cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    const row = Number(m[2]);
    const cols = rows.get(row) ?? new Map<string, XlsxCellData>();
    cols.set(m[1], cell);
    rows.set(row, cols);
  }
  return rows;
}

/** Valor "cru" da célula para validação: número, texto (aparado) ou undefined. */
export function cellValue(cell: XlsxCellData | undefined): number | string | undefined {
  if (!cell) return undefined;
  if (cell.type === "n") return cell.value as number;
  if (cell.type === "b") return cell.value ? "true" : "false";
  if (cell.type === "e") return undefined;
  const s = String(cell.value).trim();
  return s === "" ? undefined : s;
}
