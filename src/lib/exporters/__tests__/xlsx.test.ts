import { describe, expect, it } from "vitest";
import { buildXlsx, columnLetter, crc32 } from "../xlsx";

function bufferText(data: Uint8Array): string {
  // ZIP em modo STORE: o XML (UTF-8) fica em texto puro dentro do pacote;
  // os poucos bytes binários dos cabeçalhos viram replacement chars, sem afetar
  // as buscas por substring.
  return Buffer.from(data).toString("utf8");
}

describe("crc32", () => {
  it("bate com o vetor de teste padrão", () => {
    // CRC32("123456789") = 0xCBF43926 (vetor clássico da especificação)
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("columnLetter", () => {
  it("converte índices em letras de coluna", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
  });
});

describe("buildXlsx", () => {
  const sheet = {
    name: "Resumo",
    columns: [
      { key: "metrica", label: "Métrica" },
      { key: "valor", label: "Valor (R$)", type: "money" as const },
      { key: "qtd", label: "Quantidade", type: "number" as const },
    ],
    rows: [
      { metrica: "Saldo disponível", valor: 8_223_810, qtd: 2 },
      { metrica: "Vencidos & abertos <hoje>", valor: 767_000, qtd: 4 },
    ],
  };

  it("gera um pacote ZIP válido com as partes obrigatórias do xlsx", () => {
    const data = buildXlsx([sheet]);
    // Assinatura ZIP (PK\x03\x04) e EOCD (PK\x05\x06)
    expect([data[0], data[1], data[2], data[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = bufferText(data);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).toContain('<sheet name="Resumo"');
  });

  it("escreve cabeçalho em negrito, moeda em reais e texto com escape XML", () => {
    const text = bufferText(buildXlsx([sheet]));
    expect(text).toContain("<t>Métrica</t>"); // header
    expect(text).toContain('s="1"'); // estilo negrito no cabeçalho
    // 8.223.810 centavos → 82238.10 reais na célula numérica com estilo moeda
    expect(text).toContain('s="2"><v>82238.10</v>');
    expect(text).toContain('<v>7670.00</v>');
    // Texto com & e < escapados
    expect(text).toContain("Vencidos &amp; abertos &lt;hoje&gt;");
    // Números puros sem aspas
    expect(text).toContain("<v>2</v>");
  });

  it("suporta múltiplas abas e sanitiza nomes inválidos/duplicados", () => {
    const data = buildXlsx([
      { name: "Relatório: [1/2]?*", rows: [{ a: "x" }] },
      { name: "Relatório: [1/2]?*", rows: [{ a: "y" }] },
      { name: "", rows: [] },
    ]);
    const text = bufferText(data);
    expect(text).toContain("xl/worksheets/sheet3.xml");
    expect(text).not.toMatch(/<sheet name="[^"]*[[\]:*?/\\]/); // sem chars proibidos
    // Nomes únicos
    const names = [...text.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(3);
  });

  it("infere colunas da primeira linha quando não informadas e aceita aba vazia", () => {
    const text = bufferText(
      buildXlsx([{ name: "Auto", rows: [{ nome: "Ana", idade: 30 }] }, { name: "Vazia", rows: [] }])
    );
    expect(text).toContain("<t>nome</t>");
    expect(text).toContain("<v>30</v>"); // número inferido
  });

  it("valida CRC32 de cada entrada do pacote (integridade do ZIP)", () => {
    const data = buildXlsx([sheet]);
    const buf = Buffer.from(data);
    // Percorre cabeçalhos locais e confere o CRC declarado vs. calculado.
    let offset = 0;
    let checked = 0;
    while (buf.readUInt32LE(offset) === 0x04034b50) {
      const declaredCrc = buf.readUInt32LE(offset + 14);
      const size = buf.readUInt32LE(offset + 18);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const start = offset + 30 + nameLen + extraLen;
      const content = new Uint8Array(buf.subarray(start, start + size));
      expect(crc32(content)).toBe(declaredCrc);
      checked++;
      offset = start + size;
    }
    expect(checked).toBe(6); // 5 partes fixas + 1 worksheet
  });

  it("exige ao menos uma aba", () => {
    expect(() => buildXlsx([])).toThrow(/ao menos uma aba/);
  });
});
