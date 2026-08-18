/**
 * Geometria pura dos gráficos SVG server-rendered (sem bibliotecas).
 * Funções determinísticas e testáveis — as páginas apenas compõem SVG com elas.
 */

import { formatBRL } from "@/core/money";

/** Passo "bonito" (1 / 2 / 2.5 / 5 × 10^n) maior ou igual ao passo bruto. */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

export interface NiceScale {
  min: number;
  max: number;
  ticks: number[];
}

/** Expande [min, max] para limites redondos e devolve os ticks do eixo. */
export function niceScale(minValue: number, maxValue: number, tickCount = 4): NiceScale {
  let min = Math.min(minValue, maxValue);
  let max = Math.max(minValue, maxValue);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (min === max) {
    if (max > 0) min = 0;
    else if (max < 0) max = 0;
    else max = 1;
  }
  const step = niceStep((max - min) / Math.max(1, tickCount));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  return { min: Number(niceMin.toFixed(6)), max: Number(niceMax.toFixed(6)), ticks };
}

/** Interpolação linear de domínio para faixa de pixels. */
export function scaleValue(
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number
): number {
  if (domainMax === domainMin) return rangeMin;
  const t = (value - domainMin) / (domainMax - domainMin);
  return rangeMin + t * (rangeMax - rangeMin);
}

/** Path "M x0 y0 L x1 y1 ..." com 2 casas decimais. */
export function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");
}

/**
 * Retângulo com topo arredondado e base reta (spec de barra: 4px no data-end,
 * quadrado na baseline). Raio é limitado pela metade da largura e pela altura.
 */
export function roundedTopRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 4
): string {
  if (height <= 0 || width <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  const f = (n: number) => n.toFixed(2);
  return (
    `M${f(x)} ${f(y + height)} ` +
    `V${f(y + r)} ` +
    `Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)} ` +
    `H${f(x + width - r)} ` +
    `Q${f(x + width)} ${f(y)} ${f(x + width)} ${f(y + r)} ` +
    `V${f(y + height)} Z`
  );
}

const NUM_1 = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

/**
 * Rótulo compacto de eixo/valor: R$ 2,5 mi · R$ 12,3 mil · R$ 500,00.
 * Apenas exibição — todo cálculo permanece em centavos inteiros.
 */
export function formatBRLCompact(amountCents: number): string {
  const reais = amountCents / 100;
  const abs = Math.abs(reais);
  const sign = reais < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}R$\u00A0${NUM_1.format(abs / 1_000_000)} mi`;
  if (abs >= 1_000) return `${sign}R$\u00A0${NUM_1.format(abs / 1_000)} mil`;
  return formatBRL(amountCents);
}
