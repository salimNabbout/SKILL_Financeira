import { describe, expect, it } from "vitest";
import {
  linearTrend,
  mad,
  mean,
  median,
  robustStdDev,
  robustZScore,
  theilSenTrend,
  trendAt,
  MAD_TO_SIGMA,
} from "../stats";

describe("stats / medidas básicas", () => {
  it("mean e median cobrem vazio, ímpar e par", () => {
    expect(mean([])).toBe(0);
    expect(mean([2, 4, 9])).toBe(5);
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([1, 3, 100])).toBe(3); // robusta ao outlier
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("mad e robustStdDev: dispersão robusta", () => {
    expect(mad([])).toBe(0);
    expect(mad([7, 7, 7])).toBe(0);
    // mediana = 3, desvios |x−3| = [2,1,0,1,2] → MAD = 1.
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
    expect(robustStdDev([1, 2, 3, 4, 5])).toBeCloseTo(MAD_TO_SIGMA, 10);
    // Um outlier gigante quase não muda o MAD (ao contrário do desvio padrão).
    expect(mad([1, 2, 3, 4, 1_000_000])).toBe(1);
  });

  it("robustZScore: outlier claro tem escore alto; série constante degenera com sinal", () => {
    const series = [100, 102, 98, 101, 99, 103, 97, 100, 102, 98, 101, 5_000];
    expect(robustZScore(5_000, series)).toBeGreaterThan(3.5);
    expect(Math.abs(robustZScore(100, series))).toBeLessThan(1);
    // MAD zero: coincide com a mediana → 0; desvio → ±Infinity.
    expect(robustZScore(7, [7, 7, 7])).toBe(0);
    expect(robustZScore(9, [7, 7, 7])).toBe(Number.POSITIVE_INFINITY);
    expect(robustZScore(1, [7, 7, 7])).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("stats / tendências", () => {
  it("linearTrend recupera reta exata e degenera com < 2 pontos", () => {
    const t = linearTrend([10, 12, 14, 16]); // y = 10 + 2x
    expect(t.slope).toBeCloseTo(2, 10);
    expect(t.intercept).toBeCloseTo(10, 10);
    expect(trendAt(t, 5)).toBeCloseTo(20, 10);
    expect(linearTrend([])).toEqual({ slope: 0, intercept: 0 });
    expect(linearTrend([42])).toEqual({ slope: 0, intercept: 42 });
  });

  it("theilSenTrend recupera reta exata e resiste a outlier (mínimos quadrados não resiste)", () => {
    const exact = theilSenTrend([10, 12, 14, 16]);
    expect(exact.slope).toBeCloseTo(2, 10);
    expect(exact.intercept).toBeCloseTo(10, 10);

    // Série linear com um ponto corrompido: Theil–Sen mantém a inclinação ~2.
    const corrupted = [10, 12, 14, 1_000, 18, 20, 22, 24, 26];
    const robust = theilSenTrend(corrupted);
    const classic = linearTrend(corrupted);
    expect(robust.slope).toBeCloseTo(2, 5);
    expect(Math.abs(classic.slope - 2)).toBeGreaterThan(1); // contraste
    expect(theilSenTrend([5])).toEqual({ slope: 0, intercept: 5 });
  });
});
