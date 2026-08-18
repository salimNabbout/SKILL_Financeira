/**
 * Gráficos SVG server-rendered, pequenos e sem bibliotecas.
 * Especificação seguida (dataviz): barras ≤ 24px com topo arredondado 4px e base
 * reta; linha 2px; marcadores ≥ 8px com anel de 2px na cor da superfície; grade
 * hairline 1px sólida; texto SEMPRE em tokens de tinta (nunca na cor da série);
 * legenda presente com 2+ séries; tooltips nativos via <title>.
 */

import { formatBR } from "@/core/dates";
import { formatBRL } from "@/core/money";
import {
  formatBRLCompact,
  linePath,
  niceScale,
  roundedTopRectPath,
  scaleValue,
} from "./chart-geometry";

export interface InOutGroup {
  label: string;
  /** Texto do tooltip (ex.: intervalo de datas do agrupamento). */
  title?: string;
  inCents: number;
  outCents: number;
}

const MARGIN = { top: 10, right: 12, bottom: 26, left: 66 };

function ddmm(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** Barras agrupadas entradas × saídas (2 séries: --ok e --crit). */
export function InOutBarChart({
  groups,
  width = 560,
  height = 220,
}: {
  groups: InOutGroup[];
  width?: number;
  height?: number;
}) {
  if (groups.length === 0) {
    return <p className="text-sm text-[var(--ink-muted)]">Sem dados para o gráfico.</p>;
  }
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const maxValue = Math.max(0, ...groups.map((g) => Math.max(g.inCents, g.outCents)));
  const scale = niceScale(0, maxValue > 0 ? maxValue : 100_000, 4);
  const y = (v: number) =>
    scaleValue(v, scale.min, scale.max, MARGIN.top + plotH, MARGIN.top);

  const band = plotW / groups.length;
  // Duas barras por grupo, ≤ 24px cada, com vão de 2px entre elas (surface gap).
  const barW = Math.max(6, Math.min(24, (band - 18) / 2));
  const gap = 2;

  return (
    <div>
      <div className="mb-1 flex items-center gap-4 text-xs text-[var(--ink-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--ok)]" aria-hidden />
          Entradas
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--crit)]" aria-hidden />
          Saídas
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        style={{ maxWidth: width }}
        role="img"
        aria-label="Gráfico de barras: entradas versus saídas por período"
      >
        {scale.ticks.map((t) => (
          <g key={t}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--line)"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--ink-muted)"
            >
              {formatBRLCompact(t)}
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          const cx = MARGIN.left + band * i + band / 2;
          const xIn = cx - barW - gap / 2;
          const xOut = cx + gap / 2;
          const hIn = Math.max(0, y(0) - y(g.inCents));
          const hOut = Math.max(0, y(0) - y(g.outCents));
          const tooltip = `${g.title ?? g.label} — entradas ${formatBRL(g.inCents)}, saídas ${formatBRL(g.outCents)}`;
          return (
            <g key={g.label + i}>
              {hIn > 0 ? (
                <path d={roundedTopRectPath(xIn, y(g.inCents), barW, hIn)} fill="var(--ok)">
                  <title>{tooltip}</title>
                </path>
              ) : null}
              {hOut > 0 ? (
                <path d={roundedTopRectPath(xOut, y(g.outCents), barW, hOut)} fill="var(--crit)">
                  <title>{tooltip}</title>
                </path>
              ) : null}
              <text
                x={cx}
                y={height - 8}
                textAnchor="middle"
                fontSize={10}
                fill="var(--ink-muted)"
              >
                {g.label}
              </text>
            </g>
          );
        })}
        <line
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={y(Math.max(scale.min, 0))}
          y2={y(Math.max(scale.min, 0))}
          stroke="var(--ink-muted)"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}

export interface SeriesPoint {
  date: string; // ISODate
  valueCents: number;
}

/** Linha de saldo projetado (série única — sem caixa de legenda; o título nomeia). */
export function BalanceLineChart({
  points,
  width = 640,
  height = 240,
}: {
  points: SeriesPoint[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) {
    return <p className="text-sm text-[var(--ink-muted)]">Sem dados para o gráfico.</p>;
  }
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const values = points.map((p) => p.valueCents);
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 4);
  const x = (i: number) =>
    points.length === 1
      ? MARGIN.left + plotW / 2
      : scaleValue(i, 0, points.length - 1, MARGIN.left, MARGIN.left + plotW);
  const y = (v: number) =>
    scaleValue(v, scale.min, scale.max, MARGIN.top + plotH, MARGIN.top);

  const path = linePath(points.map((p, i) => ({ x: x(i), y: y(p.valueCents) })));
  const areaPath =
    points.length > 1
      ? `${path} L${x(points.length - 1).toFixed(2)} ${y(Math.max(scale.min, 0)).toFixed(2)} L${x(0).toFixed(2)} ${y(Math.max(scale.min, 0)).toFixed(2)} Z`
      : "";

  let minIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].valueCents < points[minIdx].valueCents) minIdx = i;
  }
  const last = points[points.length - 1];

  // Ticks do eixo X: primeiro, ~1/3, ~2/3 e último ponto.
  const xTickIdx = [...new Set([
    0,
    Math.floor((points.length - 1) / 3),
    Math.floor(((points.length - 1) * 2) / 3),
    points.length - 1,
  ])];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      style={{ maxWidth: width }}
      role="img"
      aria-label="Gráfico de linha do saldo projetado"
    >
      {scale.ticks.map((t) => (
        <g key={t}>
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--line)"
            strokeWidth={1}
          />
          <text
            x={MARGIN.left - 6}
            y={y(t) + 3}
            textAnchor="end"
            fontSize={10}
            fill="var(--ink-muted)"
          >
            {formatBRLCompact(t)}
          </text>
        </g>
      ))}
      {scale.min < 0 ? (
        <line
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--ink-muted)"
          strokeWidth={1}
        />
      ) : null}
      {areaPath ? <path d={areaPath} fill="var(--brand)" opacity={0.1} /> : null}
      <path
        d={path}
        fill="none"
        stroke="var(--brand)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(minIdx)}
        cy={y(points[minIdx].valueCents)}
        r={4.5}
        fill={points[minIdx].valueCents < 0 ? "var(--crit)" : "var(--brand)"}
        stroke="var(--surface)"
        strokeWidth={2}
      >
        <title>
          {`Menor saldo: ${formatBRL(points[minIdx].valueCents)} em ${formatBR(points[minIdx].date)}`}
        </title>
      </circle>
      <circle
        cx={x(points.length - 1)}
        cy={y(last.valueCents)}
        r={4.5}
        fill="var(--brand)"
        stroke="var(--surface)"
        strokeWidth={2}
      >
        <title>{`Saldo final: ${formatBRL(last.valueCents)} em ${formatBR(last.date)}`}</title>
      </circle>
      <text
        x={width - MARGIN.right}
        y={Math.max(MARGIN.top + 10, y(last.valueCents) - 8)}
        textAnchor="end"
        fontSize={10}
        fontWeight={600}
        fill="var(--ink)"
      >
        {formatBRLCompact(last.valueCents)}
      </text>
      {xTickIdx.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={height - 8}
          textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          fontSize={10}
          fill="var(--ink-muted)"
        >
          {ddmm(points[i].date)}
        </text>
      ))}
    </svg>
  );
}
