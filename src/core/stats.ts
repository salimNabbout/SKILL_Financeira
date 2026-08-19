/**
 * Estatística determinística para previsão e detecção de anomalias.
 *
 * Primitivas puras (sem I/O, sem aleatoriedade): mesmos dados → mesmos
 * resultados, sempre. Preferimos estimadores ROBUSTOS (mediana/MAD) aos
 * momentos clássicos (média/desvio padrão) porque séries financeiras de PME
 * têm outliers legítimos (13º, impostos, compras pontuais) que não devem
 * distorcer a linha de base.
 *
 * Referência do escore robusto: Iglewicz & Hoaglin (1993) — o MAD escalado por
 * 1.4826 aproxima o desvio padrão sob normalidade; |z| > 3.5 marca outlier.
 */

/** Fator que torna o MAD comparável ao desvio padrão sob distribuição normal. */
export const MAD_TO_SIGMA = 1.4826;

/** Limiar clássico de outlier para o escore robusto (Iglewicz–Hoaglin). */
export const ROBUST_OUTLIER_THRESHOLD = 3.5;

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/** Mediana por ordenação; par → média dos dois centrais. Vazio → 0. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Desvio absoluto mediano (MAD): mediana de |x − mediana(x)|. Vazio → 0. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

/** Desvio padrão robusto: MAD × 1.4826 (≈ σ sob normalidade). */
export function robustStdDev(values: number[]): number {
  return mad(values) * MAD_TO_SIGMA;
}

/**
 * Escore robusto de um ponto contra a série (Iglewicz–Hoaglin):
 * z = (x − mediana) / (MAD × 1.4826). MAD zero (série constante) → 0 quando o
 * ponto coincide com a mediana; Infinity com o sinal do desvio caso contrário.
 */
export function robustZScore(value: number, values: number[]): number {
  const med = median(values);
  const sigma = robustStdDev(values);
  const deviation = value - med;
  if (sigma === 0) {
    return deviation === 0 ? 0 : deviation > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return deviation / sigma;
}

export interface LinearTrend {
  /** Variação por passo do índice (unidade do valor por período). */
  slope: number;
  /** Valor ajustado no índice 0. */
  intercept: number;
}

/**
 * Regressão linear simples (mínimos quadrados) de valores sobre os índices
 * 0..n−1. Menos de 2 pontos → tendência nula ancorada na média.
 */
export function linearTrend(values: number[]): LinearTrend {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? values[0] : 0 };
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/** Valor previsto pela tendência no índice dado (contagem contínua da série). */
export function trendAt(trend: LinearTrend, index: number): number {
  return trend.intercept + trend.slope * index;
}

/**
 * Tendência robusta de Theil–Sen: slope = mediana das inclinações de todos os
 * pares (i<j); intercept = mediana de (valor − slope×índice). Resiste a até
 * ~29% de outliers — preferida sobre mínimos quadrados para séries financeiras.
 * O(n²) — adequada às séries semanais/mensais usadas aqui (≤ ~110 pontos).
 */
export function theilSenTrend(values: number[]): LinearTrend {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? values[0] : 0 };
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      slopes.push((values[j] - values[i]) / (j - i));
    }
  }
  const slope = median(slopes);
  const intercept = median(values.map((v, i) => v - slope * i));
  return { slope, intercept };
}
