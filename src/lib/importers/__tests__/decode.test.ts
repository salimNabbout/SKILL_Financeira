import { describe, expect, it } from "vitest";
import {
  decodeStatementBuffer,
  detectStatementFormat,
  MAX_STATEMENT_FILE_BYTES,
} from "../decode";
import { extractStatementUpload } from "../upload";

const OFX_SAMPLE = `OFXHEADER:100

<OFX><BANKMSGSRSV1><STMTTRN>
<DTPOSTED>20260810
<TRNAMT>-100.00
<FITID>DEC-1
<MEMO>TARIFA CONCILIAÇÃO
</STMTTRN></BANKMSGSRSV1></OFX>`;

describe("decodeStatementBuffer", () => {
  it("decodifica UTF-8 válido", () => {
    const result = decodeStatementBuffer(new TextEncoder().encode("conciliação bancária"));
    expect(result.content).toBe("conciliação bancária");
    expect(result.encoding).toBe("utf-8");
  });

  it("remove BOM UTF-8", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("data;valor")]);
    const result = decodeStatementBuffer(new Uint8Array(bom));
    expect(result.content).toBe("data;valor");
    expect(result.encoding).toBe("utf-8");
  });

  it("faz fallback para Windows-1252 quando os bytes não são UTF-8 (bancos BR)", () => {
    const latin1 = Buffer.from("conciliação bancária — extrato", "latin1");
    const result = decodeStatementBuffer(new Uint8Array(latin1));
    expect(result.encoding).toBe("windows-1252");
    expect(result.content).toContain("conciliação bancária");
  });

  it("decodifica pontuação exclusiva do Windows-1252 sem erro", () => {
    // 0x93/0x94 = aspas curvas; inválidos em UTF-8 isoladamente.
    const bytes = Buffer.concat([
      Buffer.from([0x93]),
      Buffer.from("PIX RECEBIDO", "latin1"),
      Buffer.from([0x94]),
    ]);
    const result = decodeStatementBuffer(new Uint8Array(bytes));
    expect(result.encoding).toBe("windows-1252");
    expect(result.content).toContain("PIX RECEBIDO");
  });
});

describe("detectStatementFormat", () => {
  it("detecta OFX pela assinatura do conteúdo, mesmo com extensão .txt", () => {
    expect(detectStatementFormat({ filename: "EXTRATO.TXT", content: OFX_SAMPLE })).toBe("ofx");
  });

  it("detecta pela extensão quando o conteúdo não tem assinatura", () => {
    expect(detectStatementFormat({ filename: "mov.ofx", content: "qualquer" })).toBe("ofx");
    expect(detectStatementFormat({ filename: "mov.csv", content: "linha única" })).toBe("csv");
  });

  it("heurística CSV: linhas compartilham separador", () => {
    const csv = "data;descricao;valor\n01/08/2026;PIX;100,00\n02/08/2026;TARIFA;-9,90";
    expect(detectStatementFormat({ content: csv })).toBe("csv");
  });

  it("retorna null quando não dá para afirmar o formato", () => {
    expect(detectStatementFormat({ content: "relatório sem estrutura tabular" })).toBeNull();
    expect(detectStatementFormat({ filename: "notas.pdf", content: "%PDF-1.7" })).toBeNull();
  });
});

describe("extractStatementUpload", () => {
  function formWith(entries: Record<string, string | File>): FormData {
    const fd = new FormData();
    for (const [key, value] of Object.entries(entries)) fd.set(key, value);
    return fd;
  }

  it("usa o arquivo enviado com detecção automática de formato", async () => {
    const csv = "data;descricao;valor\n01/08/2026;PIX LOJA;250,00";
    const fd = formWith({
      bankAccountId: "ba_1",
      format: "auto",
      arquivo: new File([csv], "extrato.csv", { type: "text/csv" }),
    });
    const upload = await extractStatementUpload(fd);
    expect(upload.format).toBe("csv");
    expect(upload.content).toBe(csv);
    expect(upload.encoding).toBe("utf-8");
    expect(upload.filename).toBe("extrato.csv");
  });

  it("decodifica arquivo OFX em ISO-8859-1 e detecta pela assinatura", async () => {
    const latin1 = Buffer.from(OFX_SAMPLE, "latin1");
    const fd = formWith({
      format: "auto",
      arquivo: new File([new Uint8Array(latin1)], "EXTRATO.TXT"),
    });
    const upload = await extractStatementUpload(fd);
    expect(upload.format).toBe("ofx");
    expect(upload.encoding).toBe("windows-1252");
    expect(upload.content).toContain("TARIFA CONCILIAÇÃO");
  });

  it("arquivo tem precedência sobre texto colado; campo 'file' também é aceito", async () => {
    const fd = formWith({
      format: "csv",
      content: "colado;ignorado",
      file: new File(["a;b\n1;2"], "extrato.csv"),
    });
    const upload = await extractStatementUpload(fd);
    expect(upload.content).toBe("a;b\n1;2");
  });

  it("sem arquivo, usa o texto colado", async () => {
    const fd = formWith({ format: "csv", content: "data;valor\n01/08/2026;10,00" });
    const upload = await extractStatementUpload(fd);
    expect(upload.format).toBe("csv");
    expect(upload.content).toContain("01/08/2026");
  });

  it("rejeita entrada vazia, formato inválido, indetectável e arquivo grande demais", async () => {
    await expect(extractStatementUpload(formWith({ format: "auto" }))).rejects.toThrow(
      /Envie o arquivo/
    );
    await expect(
      extractStatementUpload(formWith({ format: "xml", content: "x" }))
    ).rejects.toThrow(/Formato de extrato inválido/);
    await expect(
      extractStatementUpload(formWith({ format: "auto", content: "sem estrutura" }))
    ).rejects.toThrow(/detectar o formato/);
    const big = new File([new Uint8Array(MAX_STATEMENT_FILE_BYTES + 1)], "grande.ofx");
    await expect(
      extractStatementUpload(formWith({ format: "auto", arquivo: big }))
    ).rejects.toThrow(/limite de 2 MB/);
  });

  it("aplica o mesmo limite de tamanho ao texto colado (content)", async () => {
    // Conteúdo colado maior que o limite deve ser recusado (DoS de parsing).
    const huge = "a".repeat(MAX_STATEMENT_FILE_BYTES + 1);
    await expect(
      extractStatementUpload(formWith({ format: "csv", content: huge }))
    ).rejects.toThrow(/limite de 2 MB/);
  });
});
