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

  it("juros pró-rata arredondam em aritmética inteira (meio centavo sobe, sem erro de ponto flutuante)", () => {
    // R$ 66,60 × 1% a.m. × 25 dias / 30 = 55,5 centavos → 56 (half-up).
    // Em ponto flutuante, 6660 × (1/100) × 25 / 30 = 55,49999… e arredondava para 55.
    expect(computeLateFee(6660, 25, { finePercent: 0, monthlyInterestPercent: 1 }).interestCents).toBe(56);
    // R$ 33,30 × 2% a.m. × 25 dias / 30 = 55,5 → 56 (mesmo caso com outra taxa).
    expect(computeLateFee(3330, 25, { finePercent: 0, monthlyInterestPercent: 2 }).interestCents).toBe(56);
    // Taxa fracionária continua funcionando: R$ 1,20 × 1,5% × 25 / 30 = 1,5 → 2.
    expect(computeLateFee(120, 25, { finePercent: 0, monthlyInterestPercent: 1.5 }).interestCents).toBe(2);
    // Dias negativos são tratados como zero.
    expect(computeLateFee(100000, -3, { finePercent: 2, monthlyInterestPercent: 1 }).totalCents).toBe(100000);
  });
});
