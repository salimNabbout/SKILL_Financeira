import { describe, expect, it } from "vitest";
import {
  parseCnab,
  parseCsv,
  parseCsvStatement,
  parseDecimalToCents,
  parseLocalizedAmountToCents,
  parseOfx,
} from "..";

const OFX_SAMPLE = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STMTRS>
<CURDEF>BRL
<BANKACCTFROM>
<BANKID>0341
<ACCTID>12345-6
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801
<DTEND>20260818
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260815120000[-3:BRT]
<TRNAMT>1500,00
<FITID>FIT-001
<MEMO>TED RECEBIDA CLIENTE BETA
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260816
<TRNAMT>-250.75
<FITID>FIT-002
<NAME>PAGTO FORNECEDOR GAMA
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260817
<TRNAMT>-99,90
<FITID>FIT-003
<MEMO>TARIFA BANCARIA
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

describe("parseOfx", () => {
  it("extrai transações com FITID, vírgula/ponto decimal, sinal e sufixo de fuso na data", () => {
    const parsed = parseOfx(OFX_SAMPLE);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.accountId).toBe("12345-6");
    expect(parsed.transactions).toEqual([
      {
        date: "2026-08-15",
        amountCents: 150_000,
        description: "TED RECEBIDA CLIENTE BETA",
        fitid: "FIT-001",
      },
      {
        date: "2026-08-16",
        amountCents: -25_075,
        description: "PAGTO FORNECEDOR GAMA",
        fitid: "FIT-002",
      },
      {
        date: "2026-08-17",
        amountCents: -9_990,
        description: "TARIFA BANCARIA",
        fitid: "FIT-003",
      },
    ]);
  });

  it("tolera blocos sem tag de fechamento (padrão SGML OFX 1.x)", () => {
    const content = `<BANKTRANLIST>
<STMTTRN>
<DTPOSTED>20260810
<TRNAMT>100.00
<FITID>A1
<MEMO>PIX RECEBIDO
<STMTTRN>
<DTPOSTED>20260811
<TRNAMT>-50,25
<FITID>A2
<NAME>TARIFA
</BANKTRANLIST>`;
    const parsed = parseOfx(content);
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0]).toMatchObject({ date: "2026-08-10", amountCents: 10_000 });
    expect(parsed.transactions[1]).toMatchObject({ date: "2026-08-11", amountCents: -5_025 });
  });

  it("registra warning e ignora bloco com valor ou data inválidos, sem explodir", () => {
    const content = `<STMTTRN>
<DTPOSTED>20260815
<TRNAMT>abc
<FITID>X1
<MEMO>QUEBRADO
</STMTTRN>
<STMTTRN>
<DTPOSTED>data-ruim
<TRNAMT>10.00
</STMTTRN>
<STMTTRN>
<DTPOSTED>20260816
<TRNAMT>10.00
<MEMO>OK
</STMTTRN>`;
    const parsed = parseOfx(content);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0]).toMatchObject({ date: "2026-08-16", amountCents: 1_000 });
    expect(parsed.warnings).toHaveLength(2);
  });

  it("avisa quando não há blocos STMTTRN", () => {
    const parsed = parseOfx("OFXHEADER:100\n<OFX></OFX>");
    expect(parsed.transactions).toEqual([]);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseCsvStatement", () => {
  it("aceita cabeçalho pt-BR com ';', valores BR e campo entre aspas com separador interno", () => {
    const csv = [
      "Data;Histórico;Valor;Documento",
      '15/08/2026;"TED RECEBIDA; CLIENTE BETA";R$ 1.500,00;DOC-1',
      "16/08/2026;PAGTO FORNECEDOR GAMA;-1.250,75;DOC-2",
      "linha-invalida;;;",
    ].join("\n");
    const parsed = parseCsvStatement(csv);
    expect(parsed.transactions).toEqual([
      {
        date: "2026-08-15",
        amountCents: 150_000,
        description: "TED RECEBIDA; CLIENTE BETA",
        fitid: "DOC-1",
      },
      {
        date: "2026-08-16",
        amountCents: -125_075,
        description: "PAGTO FORNECEDOR GAMA",
        fitid: "DOC-2",
      },
    ]);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("linha-invalida");
  });

  it("aceita cabeçalho em inglês com ',' e data ISO", () => {
    const csv = ["date,description,amount", "2026-08-15,PIX RECEIVED,1234.56", "2026-08-16,FEE,-10.00"].join(
      "\n"
    );
    const parsed = parseCsvStatement(csv);
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0]).toMatchObject({ date: "2026-08-15", amountCents: 123_456 });
    expect(parsed.transactions[1]).toMatchObject({
      date: "2026-08-16",
      amountCents: -1_000,
      fitid: undefined,
    });
  });

  it("cabeçalho irreconhecível vira warning (sem lançar)", () => {
    const parsed = parseCsvStatement("a;b;c\n1;2;3");
    expect(parsed.transactions).toEqual([]);
    expect(parsed.warnings[0]).toContain("Cabeçalho");
  });
});

describe("parseCsv (genérico)", () => {
  it("suporta aspas escapadas e CRLF", () => {
    const rows = parseCsv('a;b\r\n"x;y";"diz ""oi"""\r\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x;y", 'diz "oi"'],
    ]);
  });
});

describe("parsers de valores monetários", () => {
  it("parseDecimalToCents: separador único é sempre decimal (padrão OFX)", () => {
    expect(parseDecimalToCents("1500,00")).toBe(150_000);
    expect(parseDecimalToCents("-250.75")).toBe(-25_075);
    expect(parseDecimalToCents("1,5")).toBe(150);
    expect(parseDecimalToCents("10")).toBe(1_000);
    expect(parseDecimalToCents("3.145")).toBe(315); // 3º dígito arredonda meio-para-cima
    expect(parseDecimalToCents("abc")).toBeNull();
  });

  it("parseLocalizedAmountToCents: formatos BR e en, com R$ e milhar", () => {
    expect(parseLocalizedAmountToCents("R$ 1.234,56")).toBe(123_456);
    expect(parseLocalizedAmountToCents("-1234.56")).toBe(-123_456);
    expect(parseLocalizedAmountToCents("1.234")).toBe(123_400); // grupo de 3 = milhar
    expect(parseLocalizedAmountToCents("1,234.56")).toBe(123_456);
    expect(parseLocalizedAmountToCents("1500")).toBe(150_000);
    expect(parseLocalizedAmountToCents("")).toBeNull();
    expect(parseLocalizedAmountToCents("x,y")).toBeNull();
  });
});

describe("parseCnab (agora implementado — alias de parseCnab240)", () => {
  it("não lança mais; conteúdo não-CNAB devolve warning tolerante", () => {
    const parsed = parseCnab("qualquer conteúdo");
    expect(parsed.transactions).toHaveLength(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});
