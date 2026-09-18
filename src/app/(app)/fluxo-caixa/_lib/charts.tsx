/**
 * Gráfico de linhas com VÁRIAS séries (SVG server-rendered, sem bibliotecas),
 * para o dashboard do Fluxo de Caixa: entradas × saídas × saldo do ano e o
 * saldo projetado nos três cenários. Mesma especificação dos gráficos do app:
 * linha 2px, marcadores com anel na cor da superfície, grade hairline, texto
 * sempre em tokens de tinta, legenda com 2+ séries, tooltips via <title>.
 */

import { formatBRL } from "@/core/money";
import { formatBRLCompact, linePath, niceScale, scaleValue } from "@/app/(app)/_lib/chart-geometry";

export type LineTone = "ok" | "crit" | "brand" | "warn" | "neutral";

const TONE_VAR: Record<LineTone, string> = {
  ok: "var(--ok)",
  crit: "var(--crit)",
  brand: "var(--brand)",
  warn: "var(--warn)",
  neutral: "var(--ink-muted)",
};

export interface LineSeries {
  label: string;
  tone: LineTone;
  /** Um valor (centavos) por rótulo do eixo X; `null` = sem ponto. */
  values: Array<number | null>;
  dashed?: boolean;
}

const MARGIN = { top: 12, right: 12, bottom: 28, left: 70 };

export function MultiLineChart({
  labels,
  series,
  width = 720,
  height = 260,
  ariaLabel,
  zeroLine = true,
}: {
  labels: string[];
  series: LineSeries[];
  width?: number;
  height?: number;
  ariaLabel: string;
  zeroLine?: boolean;
}) {
  const allValues = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (labels.length === 0 || allValues.length === 0) {
    return <p className="text-sm text-[var(--ink-muted)]">Sem dados para o gráfico.</p>;
  }
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const scale = niceScale(Math.min(0, ...allValues), Math.max(0, ...allValues), 4);
  const x = (i: number) =>
    labels.length === 1 ? MARGIN.left + plotW / 2 : scaleValue(i, 0, labels.length - 1, MARGIN.left, MARGIN.left + plotW);
  const y = (v: number) => scaleValue(v, scale.min, scale.max, MARGIN.top + plotH, MARGIN.top);
  // Rótulos do eixo X: até 12 cabem inteiros; acima disso, um a cada n.
  const step = Math.max(1, Math.ceil(labels.length / 12));

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--ink-muted)]">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{ backgroundColor: TONE_VAR[s.tone], borderTop: s.dashed ? `2px dashed ${TONE_VAR[s.tone]}` : undefined }}
              aria-hidden
            />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" style={{ maxWidth: width }} role="img" aria-label={ariaLabel}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={MARGIN.left - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--ink-muted)">
              {formatBRLCompact(t)}
            </text>
          </g>
        ))}
        {zeroLine && scale.min < 0 ? (
          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} stroke="var(--ink-muted)" strokeWidth={1} />
        ) : null}
        {labels.map((l, i) =>
          i % step === 0 || i === labels.length - 1 ? (
            <text key={l + i} x={x(i)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--ink-muted)">
              {l}
            </text>
          ) : null
        )}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === null ? null : { x: x(i), y: y(v), v, i })).filter((p): p is NonNullable<typeof p> => p !== null);
          if (pts.length === 0) return null;
          return (
            <g key={s.label}>
              <path d={linePath(pts)} fill="none" stroke={TONE_VAR[s.tone]} strokeWidth={2} strokeDasharray={s.dashed ? "6 4" : undefined} strokeLinejoin="round" />
              {pts.map((p) => (
                <circle key={p.i} cx={p.x} cy={p.y} r={3.5} fill={TONE_VAR[s.tone]} stroke="var(--surface)" strokeWidth={2}>
                  <title>{`${s.label} — ${labels[p.i]}: ${formatBRL(p.v)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
