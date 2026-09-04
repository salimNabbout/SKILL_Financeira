/**
 * `<LEDGERBAL>` — o saldo que o BANCO declara no OFX.
 *
 * O parser lia e descartava esse bloco. É a única referência externa contra a
 * qual o saldo calculado pelo app pode ser conferido, então o que importa aqui
 * é: extrair quando existe, não inventar quando não existe, e nunca confundir
 * com `<AVAILBAL>`, que tem os MESMOS nomes de campo.
 */

import { describe, expect, it } from "vitest";
import { parseOfx } from "../ofx";
import { parseCsvStatement } from "../csv";

function ofx(corpo: string): string {
  return `OFXHEADER:100
DATA:OFXSGML

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>12345-6</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260815<TRNAMT>-250.75<FITID>FIT-1<MEMO>TARIFA</STMTTRN>
</BANKTRANLIST>
${corpo}
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
}

describe("parseOfx — saldo declarado pelo banco", () => {
  it("extrai BALAMT e DTASOF do bloco LEDGERBAL", () => {
    const r = parseOfx(ofx("<LEDGERBAL><BALAMT>1234.56<DTASOF>20260831</LEDGERBAL>"));

    expect(r.ledgerBalance).toEqual({ amountCents: 123_456, date: "2026-08-31" });
    expect(r.warnings).toEqual([]);
  });

  it("aceita vírgula decimal, como alguns bancos exportam", () => {
    const r = parseOfx(ofx("<LEDGERBAL><BALAMT>1234,56<DTASOF>20260831</LEDGERBAL>"));

    expect(r.ledgerBalance?.amountCents).toBe(123_456);
  });

  it("aceita saldo negativo (conta no cheque especial)", () => {
    const r = parseOfx(ofx("<LEDGERBAL><BALAMT>-980.10<DTASOF>20260831</LEDGERBAL>"));

    expect(r.ledgerBalance?.amountCents).toBe(-98_010);
  });

  it("DTASOF com hora e fuso: usa só a data", () => {
    const r = parseOfx(ofx("<LEDGERBAL><BALAMT>10.00<DTASOF>20260831120000[-3:BRT]</LEDGERBAL>"));

    expect(r.ledgerBalance?.date).toBe("2026-08-31");
  });

  it("sem o bloco: campo ausente e NENHUM warning — é o caso normal", () => {
    const r = parseOfx(ofx(""));

    expect(r.ledgerBalance).toBeUndefined();
    expect(r.warnings).toEqual([]);
    // O resto do arquivo continua sendo lido normalmente.
    expect(r.transactions).toHaveLength(1);
  });

  it("NÃO confunde com AVAILBAL, que tem os mesmos campos", () => {
    // AVAILBAL (saldo disponível) vem antes de propósito: ler o arquivo inteiro
    // sem recortar o bloco pegaria 999,99 no lugar do saldo contábil.
    const r = parseOfx(
      ofx(
        "<AVAILBAL><BALAMT>999.99<DTASOF>20260831</AVAILBAL>" +
          "<LEDGERBAL><BALAMT>100.00<DTASOF>20260830</LEDGERBAL>"
      )
    );

    expect(r.ledgerBalance).toEqual({ amountCents: 10_000, date: "2026-08-30" });
  });

  it("não vaza para o AVAILBAL quando o LEDGERBAL vem primeiro e sem fechamento", () => {
    const r = parseOfx(
      ofx("<LEDGERBAL><BALAMT>100.00<DTASOF>20260830" + "<AVAILBAL><BALAMT>999.99<DTASOF>20260831")
    );

    expect(r.ledgerBalance?.amountCents).toBe(10_000);
  });

  it("bloco presente mas ilegível: warning, porque houve perda de informação", () => {
    const r = parseOfx(ofx("<LEDGERBAL><BALAMT>abc<DTASOF>20260831</LEDGERBAL>"));

    expect(r.ledgerBalance).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("Saldo do banco ignorado"))).toBe(true);
    // A perda é só do saldo: as transações continuam.
    expect(r.transactions).toHaveLength(1);
  });

  it("data inválida também invalida o saldo", () => {
    const r = parseOfx(ofx("<LEDGERBAL><BALAMT>10.00<DTASOF>2026</LEDGERBAL>"));

    expect(r.ledgerBalance).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("Saldo do banco ignorado"))).toBe(true);
  });
});

describe("outros formatos", () => {
  it("CSV não declara saldo: campo ausente, sem warning", () => {
    const r = parseCsvStatement("data;valor;descricao\n15/08/2026;-250,75;TARIFA\n");

    expect(r.ledgerBalance).toBeUndefined();
    expect(r.transactions).toHaveLength(1);
  });
});
