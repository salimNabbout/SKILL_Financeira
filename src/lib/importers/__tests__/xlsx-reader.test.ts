/**
 * Leitor .xlsx: ida e volta com o nosso gerador (STORE, strings inline) e um
 * pacote DEFLATE com sharedStrings, como o Excel grava.
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildXlsxWorkbook, crc32 } from "@/lib/exporters/xlsx";
import { XlsxReadError, cellValue, readXlsx, sheetRows } from "../xlsx-reader";

/** ZIP mínimo com método DEFLATE (8) — o que o Excel produz. */
function zipDeflate(entries: Array<{ name: string; data: string }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data, "utf8");
    const comp = deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, comp);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(comp.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  // Comentário no EOCD, para o leitor precisar procurar a assinatura.
  const comment = Buffer.from("comentario", "utf8");
  eocd.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...chunks, cd, eocd, comment]));
}

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Lançamentos" sheetId="1" r:id="rId1"/><sheet name="Outra" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/xl/worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Id="rId1"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
const SHARED = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>Café &amp; Cia</t></si><si><r><rPr><b/></rPr><t>Rich</t></r><r><t xml:space="preserve"> text</t></r></si></sst>`;
const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" s="3"><v>42</v></c><c r="D1" t="e"><v>#DIV/0!</v></c><c r="E1" s="2"/></row><row r="3"><c r="A3"><f>SUM(C1)</f><v>42</v></c><c r="B3" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>`;
const SHEET2 = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>outra</t></is></c></row></sheetData></worksheet>`;

function excelLike(): Uint8Array {
  return zipDeflate([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", data: RELS },
    { name: "xl/sharedStrings.xml", data: SHARED },
    { name: "xl/worksheets/sheet1.xml", data: SHEET1 },
    { name: "xl/worksheets/sheet2.xml", data: SHEET2 },
  ]);
}

describe("readXlsx — ida e volta com o gerador próprio (STORE, inline strings)", () => {
  const bytes = buildXlsxWorkbook({
    sheets: [
      {
        name: "Dados",
        cells: {
          A1: { v: "Olá & <tal>" },
          B1: { v: 12.5 },
          C1: { v: true },
          D1: { f: "SUM(B1:B1)", cached: 12.5 },
          E1: { f: 'IF(1,"OK","")', cached: "OK" },
          F1: { money: 123_456 },
          G1: { v: " espaço " },
          H1: { num: "0.1500", style: { numFmt: "percent1" } },
          A2: { style: { fill: "FFF2CC" } },
          B4: { v: 0 },
        },
      },
      { name: "Vazia", cells: {} },
    ],
  });

  it("lê nomes das abas, textos com escape, números, lógicos, fórmulas em cache, moeda e espaços nas pontas", () => {
    const wb = readXlsx(bytes);
    expect(wb.sheetNames).toEqual(["Dados", "Vazia"]);
    const sheet = wb.readSheet("Dados")!;
    expect(sheet.cells.get("A1")).toEqual({ type: "s", value: "Olá & <tal>" });
    expect(sheet.cells.get("B1")).toEqual({ type: "n", value: 12.5 });
    expect(sheet.cells.get("C1")).toEqual({ type: "b", value: true });
    expect(sheet.cells.get("D1")).toEqual({ type: "n", value: 12.5 });
    expect(sheet.cells.get("E1")).toEqual({ type: "s", value: "OK" });
    expect(sheet.cells.get("F1")).toEqual({ type: "n", value: 1234.56 });
    expect(sheet.cells.get("G1")).toEqual({ type: "s", value: " espaço " });
    expect(sheet.cells.get("H1")).toEqual({ type: "n", value: 0.15 });
    expect(sheet.cells.get("B4")).toEqual({ type: "n", value: 0 });
    // Célula só com estilo não tem valor.
    expect(sheet.cells.has("A2")).toBe(false);
    expect(sheet.maxRow).toBe(4);
    expect(wb.readSheet("Vazia")!.cells.size).toBe(0);
    expect(wb.readSheet("NãoExiste")).toBeNull();
  });

  it("sheetRows agrupa por linha e cellValue apara texto e descarta erros", () => {
    const sheet = readXlsx(bytes).readSheet("Dados")!;
    const rows = sheetRows(sheet);
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([1, 4]);
    expect(cellValue(rows.get(1)!.get("A"))).toBe("Olá & <tal>");
    expect(cellValue(rows.get(1)!.get("G"))).toBe("espaço");
    expect(cellValue(rows.get(1)!.get("B"))).toBe(12.5);
    expect(cellValue(rows.get(1)!.get("C"))).toBe("true");
    expect(cellValue(undefined)).toBeUndefined();
  });
});

describe("readXlsx — pacote DEFLATE com sharedStrings (como o Excel grava)", () => {
  it("descompacta, resolve strings compartilhadas (com rich text), fórmulas, lógicos e erros; aceita Target absoluto", () => {
    const wb = readXlsx(excelLike());
    expect(wb.sheetNames).toEqual(["Lançamentos", "Outra"]);
    const sheet = wb.readSheet("Lançamentos")!;
    expect(sheet.cells.get("A1")).toEqual({ type: "s", value: "Café & Cia" });
    expect(sheet.cells.get("B1")).toEqual({ type: "s", value: "Rich text" });
    expect(sheet.cells.get("C1")).toEqual({ type: "n", value: 42 });
    expect(sheet.cells.get("D1")).toEqual({ type: "e", value: "#DIV/0!" });
    expect(cellValue(sheet.cells.get("D1"))).toBeUndefined();
    expect(sheet.cells.has("E1")).toBe(false);
    expect(sheet.cells.get("A3")).toEqual({ type: "n", value: 42 });
    expect(sheet.cells.get("B3")).toEqual({ type: "s", value: "xy" });
    expect(sheet.cells.get("C3")).toEqual({ type: "b", value: true });
    expect(wb.readSheet("Outra")!.cells.get("A1")).toEqual({ type: "s", value: "outra" });
  });

  it("rejeita bytes que não são ZIP, pacote sem workbook.xml e partes acima do teto (zip bomb)", () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(XlsxReadError);
    expect(() => readXlsx(new TextEncoder().encode("isto não é um xlsx, só texto longo o bastante"))).toThrow(XlsxReadError);
    const semWorkbook = zipDeflate([{ name: "a.txt", data: "x" }]);
    expect(() => readXlsx(semWorkbook)).toThrow(/workbook\.xml/);
    expect(() => readXlsx(excelLike(), { maxEntryBytes: 16 })).toThrow(XlsxReadError);
  });
});
