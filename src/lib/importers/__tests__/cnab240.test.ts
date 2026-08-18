import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { runSkill } from "@/core/skill";
import { conciliacaoSkill } from "@/skills/conciliacao";
import { detectStatementFormat } from "../decode";
import { CNAB240_LAYOUT, CNAB240_LINE_LENGTH, looksLikeCnab240, parseCnab240 } from "../cnab";

/** Monta uma linha de 240 chars preenchendo campos pelas MESMAS constantes do parser. */
function line(fields: Partial<Record<keyof typeof CNAB240_LAYOUT, string>>): string {
  const chars = new Array<string>(CNAB240_LINE_LENGTH).fill(" ");
  for (const [key, value] of Object.entries(fields)) {
    const [start, end] = CNAB240_LAYOUT[key as keyof typeof CNAB240_LAYOUT];
    const width = end - start + 1;
    const text = String(value).slice(0, width);
    for (let i = 0; i < text.length; i++) chars[start - 1 + i] = text[i];
  }
  return chars.join("");
}

const HEADER = line({ bank: "341", recordType: "0" });
const TRAILER = line({ bank: "341", recordType: "9" });

function segmentoE(over: Partial<Record<keyof typeof CNAB240_LAYOUT, string>>): string {
  return line({
    bank: "341",
    recordType: "3",
    segment: "E",
    date: "15082026",
    amount: "000000000000250000", // R$ 2.500,00
    debitCredit: "C",
    history: "PIX RECEBIDO CLIENTE",
    complement: "DOC 998877",
    ...over,
  });
}

describe("parseCnab240", () => {
  it("converte segmentos E em transações (crédito e débito, centavos implícitos)", () => {
    const content = [
      HEADER,
      segmentoE({}),
      segmentoE({ date: "16082026", amount: "000000000000008990", debitCredit: "D", history: "TARIFA PACOTE", complement: "" }),
      TRAILER,
    ].join("\r\n");

    const parsed = parseCnab240(content);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0]).toMatchObject({
      date: "2026-08-15",
      amountCents: 250_000,
      description: "PIX RECEBIDO CLIENTE DOC 998877",
    });
    expect(parsed.transactions[1]).toMatchObject({
      date: "2026-08-16",
      amountCents: -8_990,
      description: "TARIFA PACOTE",
    });
  });

  it("é tolerante: linhas malformadas e segmentos não-E viram warnings", () => {
    const content = [
      HEADER,
      "linha curta demais",
      segmentoE({ segment: "A" }), // segmento de pagamento — ignorado
      segmentoE({ date: "99999999" }),
      segmentoE({ amount: "ABC" + "0".repeat(15) }),
      segmentoE({ debitCredit: "X" }),
      segmentoE({}),
      TRAILER,
    ].join("\n");

    const parsed = parseCnab240(content);
    expect(parsed.transactions).toHaveLength(1);
    // 5 problemas plantados: linha curta, segmento A, data, valor e natureza.
    expect(parsed.warnings).toHaveLength(5);
    expect(parsed.warnings.join(" ")).toMatch(/caracteres|segmento|data|valor|natureza/);
  });

  it("arquivo sem segmento E avisa em vez de falhar", () => {
    const parsed = parseCnab240([HEADER, TRAILER].join("\n"));
    expect(parsed.transactions).toHaveLength(0);
    expect(parsed.warnings[0]).toMatch(/Nenhum detalhe segmento E/);
  });
});

describe("detecção de formato CNAB240", () => {
  it("reconhece pela estrutura (240 chars, banco numérico, tipo de registro)", () => {
    expect(looksLikeCnab240([HEADER, segmentoE({})].join("\n"))).toBe(true);
    expect(looksLikeCnab240("data;valor\n01/08/2026;10,00")).toBe(false);
  });

  it("detectStatementFormat prioriza estrutura e aceita extensões .ret/.rem", () => {
    expect(detectStatementFormat({ filename: "EXTRATO.TXT", content: [HEADER, segmentoE({})].join("\n") })).toBe(
      "cnab240"
    );
    expect(detectStatementFormat({ filename: "retorno.ret", content: "qualquer" })).toBe("cnab240");
  });
});

describe("skill de conciliação com CNAB240", () => {
  it("importa arquivo CNAB240 de ponta a ponta com deduplicação por hash", async () => {
    const env = createTestEnv();
    const now = env.clock.now().toISOString();
    env.db.bankAccounts.push({
      id: "ba_1",
      companyId: env.company.id,
      name: "Conta Principal",
      bankCode: "341",
      agency: "0001",
      accountNumberMasked: "***1",
      type: "checking",
      currency: "BRL",
      openingBalanceCents: 0,
      openingBalanceDate: "2026-01-01",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const content = [HEADER, segmentoE({}), TRAILER].join("\r\n");

    const first = await runSkill(conciliacaoSkill, env.ctx(), {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "cnab240",
      content,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((first.data as any).imported).toBe(1);
    expect(env.db.bankTransactions[0]).toMatchObject({
      amountCents: 250_000,
      date: "2026-08-15",
      source: "cnab240",
    });

    const again = await runSkill(conciliacaoSkill, env.ctx(), {
      action: "import_statement",
      bankAccountId: "ba_1",
      format: "cnab240",
      content,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((again.data as any).duplicates).toBe(1);
    expect(env.db.bankTransactions).toHaveLength(1);
  });
});
