import { describe, expect, it } from "vitest";
import { normalizePeriod, parseBudgetCsv, parseMoneyToCents } from "../csv";

describe("parseMoneyToCents", () => {
  it("aceita formato pt-BR com milhar e decimal", () => {
    expect(parseMoneyToCents("1.234,56")).toBe(123456);
    expect(parseMoneyToCents("12500,00")).toBe(1250000);
    expect(parseMoneyToCents("12,5")).toBe(1250);
    expect(parseMoneyToCents("R$ 2.500,00")).toBe(250000);
  });

  it("aceita formato en e inteiros", () => {
    expect(parseMoneyToCents("1234.56")).toBe(123456);
    expect(parseMoneyToCents("45000")).toBe(4500000);
    expect(parseMoneyToCents("0")).toBe(0);
  });

  it("um único separador seguido de 3 dígitos é milhar", () => {
    expect(parseMoneyToCents("1.234")).toBe(123400);
    expect(parseMoneyToCents("1.234.567")).toBe(123456700);
  });

  it("preserva sinal negativo", () => {
    expect(parseMoneyToCents("-10,50")).toBe(-1050);
  });

  it("rejeita entradas inválidas", () => {
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("R$")).toBeNull();
    expect(parseMoneyToCents("1.234,567")).toBeNull(); // 3 casas decimais
  });

  it("única vírgula seguida de 3 dígitos é milhar (consistente com ponto)", () => {
    expect(parseMoneyToCents("12,345")).toBe(1234500);
  });
});

describe("normalizePeriod", () => {
  it("aceita YYYY-MM e MM/YYYY", () => {
    expect(normalizePeriod("2026-08")).toBe("2026-08");
    expect(normalizePeriod("8/2026")).toBe("2026-08");
    expect(normalizePeriod("12/2026")).toBe("2026-12");
  });

  it("rejeita períodos inválidos", () => {
    expect(normalizePeriod("2026-13")).toBeNull();
    expect(normalizePeriod("2026")).toBeNull();
    expect(normalizePeriod("13/2026")).toBeNull();
  });
});

describe("parseBudgetCsv", () => {
  it("caminho feliz: ignora comentários e vazios, normaliza períodos", () => {
    const text = [
      "# comentário",
      "",
      "cat_pessoal;2026-01;12500,00",
      "cat_marketing;1/2026;3.200,50",
      "cat_vendas;2026-02;45000",
    ].join("\n");
    const result = parseBudgetCsv(text);
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual([
      { categoryId: "cat_pessoal", period: "2026-01", amountCents: 1250000 },
      { categoryId: "cat_marketing", period: "2026-01", amountCents: 320050 },
      { categoryId: "cat_vendas", period: "2026-02", amountCents: 4500000 },
    ]);
  });

  it("soma duplicatas da mesma categoria e mês", () => {
    const result = parseBudgetCsv("cat_a;2026-03;100,00\ncat_a;2026-03;50,00");
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual([
      { categoryId: "cat_a", period: "2026-03", amountCents: 15000 },
    ]);
  });

  it("reporta erros com o número da linha", () => {
    const text = ["cat_ok;2026-01;10,00", "só_dois_campos;2026-01", "cat_x;9999-99;5", "cat_y;2026-01;abc", "cat_z;2026-01;-5,00"].join(
      "\n"
    );
    const result = parseBudgetCsv(text);
    expect(result.lines).toHaveLength(1);
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toContain("Linha 2");
    expect(result.errors[1]).toContain("Linha 3");
    expect(result.errors[1]).toContain("período inválido");
    expect(result.errors[2]).toContain("Linha 4");
    expect(result.errors[2]).toContain("valor inválido");
    expect(result.errors[3]).toContain("Linha 5");
    expect(result.errors[3]).toContain("negativo");
  });

  it("aceita TAB como separador", () => {
    const result = parseBudgetCsv("cat_a\t2026-05\t1.000,00");
    expect(result.errors).toEqual([]);
    expect(result.lines[0]).toEqual({
      categoryId: "cat_a",
      period: "2026-05",
      amountCents: 100000,
    });
  });
});
