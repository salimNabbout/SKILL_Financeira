/**
 * Gerador de relatório PDF simples com pdf-lib (fontes padrão Helvetica).
 * A4, margens de 50pt, seções com texto corrido (wrap manual) e tabelas
 * com colunas distribuídas na largura útil, zebra e quebra de página.
 *
 * Restrição pdf-lib: Helvetica usa codificação WinAnsi — caracteres fora
 * dela (ex.: emojis, CJK) quebram a renderização; sanitizamos para "?".
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

export interface PdfReportSection {
  heading: string;
  lines?: string[];
  table?: {
    headers: string[];
    rows: string[][];
    /** Índice da coluna de status, para colorir o texto conforme a situação. */
    statusColumnIndex?: number;
    /** Linha final destacada (totais), fora da zebra. */
    totalsRow?: string[];
  };
}

export interface PdfReportOptions {
  title: string;
  subtitle?: string;
  sections: PdfReportSection[];
  /** Data/hora de geração exibida no cabeçalho; default: instante atual. */
  generatedAtLabel?: string;
  /** Retrato por padrão — os relatórios existentes seguem inalterados. */
  orientation?: "portrait" | "landscape";
  /** Filtros aplicados, exibidos no cabeçalho: sem isso o relatório impresso
   *  não diz a que recorte se refere. */
  filtersLabel?: string;
}

// A4 em pontos
// A4 em pontos (retrato). Paisagem é a mesma folha com os lados trocados.
const A4_SHORT = 595.28;
const A4_LONG = 841.89;
const PAGE_WIDTH = A4_SHORT;
const PAGE_HEIGHT = A4_LONG;
const MARGIN = 50;
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const TITLE_SIZE = 20;
const SUBTITLE_SIZE = 12;
const META_SIZE = 9;
const HEADING_SIZE = 13;
const BODY_SIZE = 10;
const TABLE_SIZE = 9;
const LINE_GAP = 4;
const CELL_PADDING = 4;

const GRAY = rgb(0.45, 0.45, 0.45);
const BLACK = rgb(0.1, 0.1, 0.1);
const ZEBRA = rgb(0.94, 0.94, 0.94);
const RULE = rgb(0.6, 0.6, 0.6);
// Semânticas do design system (--crit, --ok, --brand) convertidas para RGB.
const CRIT = rgb(0.70, 0.15, 0.12);
const OK = rgb(0.10, 0.50, 0.31);
const BRAND = rgb(0.06, 0.30, 0.51);

/**
 * Cor do texto de status. Atrasado/cancelado em vermelho, pago em verde, o
 * que ainda vai vencer em azul — a mesma leitura da tela, para quem recebe o
 * PDF impresso não precisar decorar rótulo.
 */
function statusColor(label: string): ReturnType<typeof rgb> {
  const t = label.toLowerCase();
  if (t.includes("atras") || t.includes("vencid") || t.includes("cancel")) return CRIT;
  if (t.includes("pago") || t.includes("recebid") || t.includes("execut")) return OK;
  if (t.includes("aberto") || t.includes("agendad") || t.includes("vencer")) return BRAND;
  return BLACK;
}

// Codepoints extras do WinAnsi fora de Latin-1 (faixa 0x80–0x9F remapeada).
const WINANSI_EXTRAS = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/**
 * Substitui por "?" todo caractere sem glifo em Helvetica/WinAnsi.
 * Latin-1 imprimível (inclui "ç", "ã", "é" etc.) passa intacto.
 */
export function sanitizeWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09) {
      out += "  ";
    } else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
    } else if (WINANSI_EXTRAS.has(code)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/** Quebra texto em linhas que caibam em maxWidth (palavras longas são fatiadas). */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth;

  const pushWord = (word: string) => {
    // Palavra maior que a largura útil: fatiar caractere a caractere.
    let chunk = "";
    for (const ch of word) {
      if (fits(chunk + ch)) {
        chunk += ch;
      } else {
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
    }
    current = chunk;
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
    } else if (current) {
      lines.push(current);
      if (fits(word)) current = word;
      else pushWord(word);
    } else {
      pushWord(word);
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Trunca com reticências quando o texto excede a largura da coluna. */
function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = "…"; // existe em WinAnsi (0x85)
  let out = "";
  for (const ch of text) {
    if (font.widthOfTextAtSize(out + ch + ellipsis, size) > maxWidth) break;
    out += ch;
  }
  return out + ellipsis;
}

interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  /** Dimensões da página em uso — mudam com a orientação. */
  pageWidth: number;
  pageHeight: number;
  usableWidth: number;
}

function newPage(c: Cursor): void {
  c.page = c.doc.addPage([c.pageWidth, c.pageHeight]);
  c.y = c.pageHeight - MARGIN;
}

/** Garante espaço vertical; ao quebrar página, repete o heading com "(continuação)". */
function ensureSpace(c: Cursor, needed: number, continuationHeading?: string): void {
  if (c.y - needed >= MARGIN) return;
  newPage(c);
  if (continuationHeading) {
    drawHeading(c, `${continuationHeading} (continuação)`);
  }
}

function drawHeading(c: Cursor, heading: string): void {
  const text = sanitizeWinAnsi(heading);
  c.y -= HEADING_SIZE;
  c.page.drawText(text, { x: MARGIN, y: c.y, size: HEADING_SIZE, font: c.bold, color: BLACK });
  c.y -= 8;
}

function drawTable(
  c: Cursor,
  heading: string,
  table: {
    headers: string[];
    rows: string[][];
    statusColumnIndex?: number;
    totalsRow?: string[];
  }
): void {
  const colCount = Math.max(1, table.headers.length);
  const colWidth = c.usableWidth / colCount;
  const cellMaxWidth = colWidth - 2 * CELL_PADDING;
  const rowHeight = TABLE_SIZE + 2 * CELL_PADDING;

  const drawHeaderRow = () => {
    ensureSpace(c, rowHeight + 2, heading);
    const top = c.y;
    for (let i = 0; i < table.headers.length; i++) {
      const text = truncateToWidth(sanitizeWinAnsi(table.headers[i]), c.bold, TABLE_SIZE, cellMaxWidth);
      c.page.drawText(text, {
        x: MARGIN + i * colWidth + CELL_PADDING,
        y: top - CELL_PADDING - TABLE_SIZE,
        size: TABLE_SIZE,
        font: c.bold,
        color: BLACK,
      });
    }
    c.y = top - rowHeight;
    // Linha separadora sob o cabeçalho
    c.page.drawLine({
      start: { x: MARGIN, y: c.y },
      end: { x: MARGIN + c.usableWidth, y: c.y },
      thickness: 0.8,
      color: RULE,
    });
    c.y -= 2;
  };

  drawHeaderRow();

  table.rows.forEach((row, rowIndex) => {
    if (c.y - rowHeight < MARGIN) {
      newPage(c);
      drawHeading(c, `${sanitizeWinAnsi(heading)} (continuação)`);
      drawHeaderRow();
    }
    const top = c.y;
    if (rowIndex % 2 === 1) {
      c.page.drawRectangle({
        x: MARGIN,
        y: top - rowHeight,
        width: c.usableWidth,
        height: rowHeight,
        color: ZEBRA,
      });
    }
    for (let i = 0; i < colCount; i++) {
      const raw = row[i] ?? "";
      const text = truncateToWidth(sanitizeWinAnsi(raw), c.regular, TABLE_SIZE, cellMaxWidth);
      c.page.drawText(text, {
        x: MARGIN + i * colWidth + CELL_PADDING,
        y: top - CELL_PADDING - TABLE_SIZE,
        size: TABLE_SIZE,
        font: c.regular,
        color: i === table.statusColumnIndex ? statusColor(raw) : BLACK,
      });
    }
    c.y = top - rowHeight;
  });

  if (table.totalsRow) {
    if (c.y - rowHeight < MARGIN) {
      newPage(c);
      drawHeaderRow();
    }
    const top = c.y;
    c.page.drawLine({
      start: { x: MARGIN, y: top },
      end: { x: MARGIN + c.usableWidth, y: top },
      thickness: 0.8,
      color: RULE,
    });
    for (let i = 0; i < colCount; i++) {
      const raw = table.totalsRow[i] ?? "";
      if (!raw) continue;
      const text = truncateToWidth(sanitizeWinAnsi(raw), c.bold, TABLE_SIZE, cellMaxWidth);
      c.page.drawText(text, {
        x: MARGIN + i * colWidth + CELL_PADDING,
        y: top - CELL_PADDING - TABLE_SIZE,
        size: TABLE_SIZE,
        font: c.bold,
        color: BLACK,
      });
    }
    c.y = top - rowHeight;
  }

  c.y -= 8;
}

/** Rodapé "Página X de Y" em todas as páginas, escrito no fim, quando o total
 *  já é conhecido. */
function drawPageFooters(doc: PDFDocument, font: PDFFont): void {
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const texto = `Página ${i + 1} de ${pages.length}`;
    const largura = font.widthOfTextAtSize(texto, META_SIZE);
    page.drawText(texto, {
      x: page.getWidth() - MARGIN - largura,
      y: MARGIN / 2,
      size: META_SIZE,
      font,
      color: GRAY,
    });
  });
}

/** Monta um relatório PDF A4 com título, seções de texto e tabelas simples. */
export async function buildPdfReport(opts: PdfReportOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const paisagem = opts.orientation === "landscape";
  const pageWidth = paisagem ? A4_LONG : A4_SHORT;
  const pageHeight = paisagem ? A4_SHORT : A4_LONG;
  const usableWidth = pageWidth - 2 * MARGIN;

  const c: Cursor = {
    doc,
    page: doc.addPage([pageWidth, pageHeight]),
    y: pageHeight - MARGIN,
    regular,
    bold,
    pageWidth,
    pageHeight,
    usableWidth,
  };

  // Cabeçalho: título grande, subtítulo cinza, data de geração
  c.y -= TITLE_SIZE;
  c.page.drawText(sanitizeWinAnsi(opts.title), {
    x: MARGIN,
    y: c.y,
    size: TITLE_SIZE,
    font: bold,
    color: BLACK,
  });
  c.y -= 8;
  if (opts.subtitle) {
    c.y -= SUBTITLE_SIZE;
    c.page.drawText(sanitizeWinAnsi(opts.subtitle), {
      x: MARGIN,
      y: c.y,
      size: SUBTITLE_SIZE,
      font: regular,
      color: GRAY,
    });
    c.y -= 4;
  }
  const generatedAt =
    opts.generatedAtLabel ??
    new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Sao_Paulo",
    }).format(new Date());
  c.y -= META_SIZE;
  c.page.drawText(sanitizeWinAnsi(`Gerado em ${generatedAt}`), {
    x: MARGIN,
    y: c.y,
    size: META_SIZE,
    font: regular,
    color: GRAY,
  });
  if (opts.filtersLabel) {
    c.y -= META_SIZE + 2;
    c.page.drawText(sanitizeWinAnsi(opts.filtersLabel), {
      x: MARGIN,
      y: c.y,
      size: META_SIZE,
      font: regular,
      color: GRAY,
    });
  }
  c.y -= 6;
  c.page.drawLine({
    start: { x: MARGIN, y: c.y },
    end: { x: MARGIN + c.usableWidth, y: c.y },
    thickness: 1,
    color: RULE,
  });
  c.y -= 14;

  for (const section of opts.sections) {
    ensureSpace(c, HEADING_SIZE + 20);
    drawHeading(c, section.heading);

    for (const line of section.lines ?? []) {
      const wrapped = wrapText(sanitizeWinAnsi(line), regular, BODY_SIZE, c.usableWidth);
      for (const piece of wrapped) {
        ensureSpace(c, BODY_SIZE + LINE_GAP, section.heading);
        c.y -= BODY_SIZE;
        c.page.drawText(piece, { x: MARGIN, y: c.y, size: BODY_SIZE, font: regular, color: BLACK });
        c.y -= LINE_GAP;
      }
    }
    if ((section.lines?.length ?? 0) > 0) c.y -= 4;

    if (section.table) {
      drawTable(c, section.heading, section.table);
    }
    c.y -= 8;
  }

  drawPageFooters(doc, regular);
  return doc.save();
}
