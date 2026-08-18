import { describe, expect, it } from "vitest";
import { computeLateFee, formatBRL, percentOf, splitInstallments } from "../money";

describe("money", () => {
  it("formata BRL corretamente", () => {
    expect(formatBRL(123456).replace(/ /g, " ")).toBe("R$ 1.234,56");
    expect(formatBRL(-5000).replace(/ /g, " ")).toBe("-R$ 50,00");
  });

  it("calcula percentual com arredondamento em centavos", () => {
    expect(percentOf(10000, 2)).toBe(200);
    expect(percentOf(333, 10)).toBe(33);
  });

  it("divide parcelas somando exatamente o total", () => {
    expect(splitInstallments(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(splitInstallments(10000, 3).reduce((a, b) => a + b, 0)).toBe(10000);
    expect(splitInstallments(100, 1)).toEqual([100]);
  });

  it("rejeita número de parcelas inválido", () => {
    expect(() => splitInstallments(100, 0)).toThrow();
    expect(() => splitInstallments(100, 1.5)).toThrow();
  });

  it("calcula multa e juros pro rata die com fórmula explícita", () => {
    // principal R$ 1.000,00; 2% multa; 1% a.m.; 15 dias de atraso
    const result = computeLateFee(100000, 15, { finePercent: 2, monthlyInterestPercent: 1 });
    expect(result.fineCents).toBe(2000); // 2%
    expect(result.interestCents).toBe(500); // 1%/30 * 15 = 0,5%
    expect(result.totalCents).toBe(102500);
    expect(result.formula).toContain("principal");
  });

  it("sem atraso não cobra multa nem juros", () => {
    const result = computeLateFee(100000, 0, { finePercent: 2, monthlyInterestPercent: 1 });
    expect(result.totalCents).toBe(100000);
  });
});
