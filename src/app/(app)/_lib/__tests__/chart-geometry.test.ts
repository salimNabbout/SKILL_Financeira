import { describe, expect, it } from "vitest";
import { formatBRL } from "@/core/money";
import {
  formatBRLCompact,
  linePath,
  niceScale,
  niceStep,
  roundedTopRectPath,
  scaleValue,
} from "../chart-geometry";

describe("niceStep", () => {
  it("arredonda para 1/2/2.5/5 × 10^n", () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.7)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(21.75)).toBe(25);
    expect(niceStep(120_000)).toBe(200_000);
  });

  it("é defensivo com entradas inválidas", () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
});

describe("niceScale", () => {
  it("expande para limites redondos com ticks exatos", () => {
    expect(niceScale(0, 87, 4)).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
  });

  it("inclui domínio negativo (saldo abaixo de zero)", () => {
    const s = niceScale(-30, 87, 4);
    expect(s.min).toBeLessThanOrEqual(-30);
    expect(s.max).toBeGreaterThanOrEqual(87);
    expect(s.ticks).toContain(0);
  });

  it("trata domínio degenerado (min === max)", () => {
    const s = niceScale(50, 50, 4);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(50);
    expect(niceScale(0, 0, 4).max).toBeGreaterThan(0);
  });
});

describe("scaleValue", () => {
  it("interpola linearmente (eixo y invertido do SVG)", () => {
    expect(scaleValue(0, 0, 100, 200, 0)).toBe(200);
    expect(scaleValue(100, 0, 100, 200, 0)).toBe(0);
    expect(scaleValue(50, 0, 100, 200, 0)).toBe(100);
  });

  it("não divide por zero com domínio vazio", () => {
    expect(scaleValue(10, 5, 5, 0, 100)).toBe(0);
  });
});

describe("linePath", () => {
  it("gera path M/L com 2 casas", () => {
    expect(linePath([{ x: 0, y: 1.005 }, { x: 10.5, y: 2 }])).toBe("M0.00 1.00 L10.50 2.00");
    expect(linePath([{ x: 3, y: 4 }])).toBe("M3.00 4.00");
    expect(linePath([])).toBe("");
  });
});

describe("roundedTopRectPath", () => {
  it("gera topo arredondado e base reta", () => {
    const d = roundedTopRectPath(10, 20, 20, 40, 4);
    expect(d.startsWith("M10.00 60.00")).toBe(true);
    expect(d).toContain("Q10.00 20.00 14.00 20.00");
    expect(d.endsWith("V60.00 Z")).toBe(true);
  });

  it("limita o raio pela altura e pela metade da largura", () => {
    // altura 2 < raio 4 → raio efetivo 2
    expect(roundedTopRectPath(0, 0, 20, 2, 4)).toContain("Q0.00 0.00 2.00 0.00");
    // largura 4 → raio efetivo 2
    expect(roundedTopRectPath(0, 0, 4, 40, 4)).toContain("Q0.00 0.00 2.00 0.00");
  });

  it("não desenha barra sem altura ou largura", () => {
    expect(roundedTopRectPath(0, 0, 10, 0)).toBe("");
    expect(roundedTopRectPath(0, 0, 0, 10)).toBe("");
  });
});

describe("formatBRLCompact", () => {
  it("compacta milhares e milhões (apenas exibição)", () => {
    expect(formatBRLCompact(12_345_00)).toBe("R$\u00A012,3 mil");
    expect(formatBRLCompact(2_500_000_00)).toBe("R$\u00A02,5 mi");
    expect(formatBRLCompact(1_000_00)).toBe("R$\u00A01 mil");
    expect(formatBRLCompact(-12_345_00)).toBe("-R$\u00A012,3 mil");
  });

  it("valores pequenos usam formatBRL integral", () => {
    expect(formatBRLCompact(500_00)).toBe(formatBRL(500_00));
    expect(formatBRLCompact(0)).toBe(formatBRL(0));
  });
});
