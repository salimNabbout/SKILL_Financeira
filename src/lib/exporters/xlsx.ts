/**
 * Exportador Excel (.xlsx) sem dependências externas.
 *
 * Um .xlsx é um pacote ZIP com XML (SpreadsheetML). Este módulo gera o pacote
 * mínimo que o Excel/LibreOffice/Google Sheets abrem: [Content_Types].xml,
 * _rels/.rels, xl/workbook.xml (+rels), xl/styles.xml e uma worksheet por aba.
 * O ZIP usa método STORE (sem compressão) — arquivos pequenos, código
 * determinístico e auditável; strings ficam inline (sem sharedStrings).
 *
 * Convenções de célula:
 *  - "text": string inline (default);
 *  - "money": valor de entrada em CENTAVOS (inteiro) → célula numérica em
 *    reais com formato #.##0,00 (o Excel aplica o separador da localidade);
 *  - "number": numérico puro.
 */

export interface XlsxColumn {
  key: string;
  label: string;
  type?: "text" | "money" | "number";
}

export interface XlsxSheet {
  name: string;
  /** Sem columns, infere das chaves da primeira linha (tipo text). */
  columns?: XlsxColumn[];
  rows: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 → A, 25 → Z, 26 → AA... */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Nomes de aba: máx. 31 chars, sem []:*?/\ e únicos. */
function sanitizeSheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let name = (s.name || `Planilha ${i + 1}`).replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
    if (!name) name = `Planilha ${i + 1}`;
    let candidate = name;
    let n = 2;
    while (used.has(candidate)) candidate = `${name.slice(0, 28)} ${n++}`;
    used.add(candidate);
    return candidate;
  });
}

// Estilos: 0 = padrão; 1 = cabeçalho em negrito; 2 = moeda (#,##0.00 → numFmt 164).
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

function cellXml(ref: string, value: unknown, type: XlsxColumn["type"]): string {
  if (value === null || value === undefined || value === "") return "";
  if (type === "money") {
    const cents = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(cents)) return "";
    // Entrada em centavos → reais com 2 casas exatas (sem float acumulado).
    const reais = (cents / 100).toFixed(2);
    return `<c r="${ref}" s="2"><v>${reais}</v></c>`;
  }
  if (type === "number" || (type === undefined && typeof value === "number")) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "";
    return `<c r="${ref}"><v>${n}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  // Sem tipo explícito, a célula autodetecta: number vira numérica, resto texto.
  const columns: XlsxColumn[] =
    sheet.columns ?? Object.keys(sheet.rows[0] ?? {}).map((key) => ({ key, label: key }));

  const cols = `<cols>${columns.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="22" customWidth="1"/>`).join("")}</cols>`;

  const headerCells = columns
    .map((c, i) => `<c r="${columnLetter(i)}1" s="1" t="inlineStr"><is><t>${xmlEscape(c.label)}</t></is></c>`)
    .join("");
  const bodyRows = sheet.rows
    .map((row, r) => {
      const cells = columns
        .map((c, i) => cellXml(`${columnLetter(i)}${r + 2}`, row[c.key], c.type))
        .join("");
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    cols +
    `<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>` +
    `</worksheet>`
  );
}

// ---------------------------------------------------------------------------
// ZIP (método STORE) — cabeçalhos locais + diretório central + EOCD
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // Data/hora DOS fixas (1980-01-01) — pacote determinístico e reprodutível.
  const dosTime = 0;
  const dosDate = 0x21;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão mínima
    local.writeUInt16LE(0x0800, 6); // flag: nomes em UTF-8
    local.writeUInt16LE(0, 8); // método STORE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, Buffer.from(entry.data));

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // criado por
    dir.writeUInt16LE(20, 6); // versão mínima
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    // extra/comment/disco/atributos: zeros; offset do cabeçalho local:
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += 30 + nameBytes.length + entry.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return new Uint8Array(Buffer.concat([...chunks, centralBuf, eocd]));
}

// ---------------------------------------------------------------------------
// Montagem do pacote xlsx
// ---------------------------------------------------------------------------

export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("buildXlsx exige ao menos uma aba.");
  const names = sanitizeSheetNames(sheets);
  const enc = (s: string) => new TextEncoder().encode(s);

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join("") +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    names.map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", data: enc(contentTypes) },
    { name: "_rels/.rels", data: enc(rootRels) },
    { name: "xl/workbook.xml", data: enc(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc(workbookRels) },
    { name: "xl/styles.xml", data: enc(STYLES_XML) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc(sheetXml(s)) })),
  ]);
}
