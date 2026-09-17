"use client";

/**
 * Painel por Período (topo do Dashboard) — Client Component.
 *
 * Lê o estado dos filtros da URL (a página já renderiza o resultado inicial
 * no servidor), e a cada troca de filtro: atualiza a query string com
 * history.replaceState (recarregar mantém a seleção) e busca o endpoint
 * GET /api/v1/dashboard/period-panel — sem recarregar a página. Os 4 totais e
 * o gráfico reagem só ao período; centro de custo e categoria só às caixas
 * próprias. Nada é somado aqui: os agregados vêm do banco via skill.
 */

import { useEffect, useRef, useState } from "react";
import { Card, EmptyState, StatCard } from "@/components/ui";
import { formatBRL } from "@/core/money";
import type { SkillResult } from "@/core/types";
import type { PeriodPanelData } from "@/skills/relatorios";
import { LabeledBarChart } from "./charts";
import { SkillResultMeta } from "./result-meta";
import {
  daysInMonthOf,
  MONTH_LABELS,
  panelQueryToSearch,
  type PanelQueryState,
} from "./period-panel-query";

export type PeriodPanelResult = SkillResult<PeriodPanelData | null>;

const selectClass =
  "rounded-lg border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-[var(--ink)] disabled:opacity-50";

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export function PeriodPanel({
  initial,
  initialQuery,
}: {
  initial: PeriodPanelResult;
  initialQuery: PanelQueryState;
}) {
  const [query, setQuery] = useState<PanelQueryState>(initialQuery);
  const [result, setResult] = useState<PeriodPanelResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRender = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  // A cada mudança de filtro: URL + fetch (o primeiro render já veio do servidor).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const search = panelQueryToSearch(query);
    try {
      window.history.replaceState(null, "", `${window.location.pathname}?${search}`);
    } catch {
      /* ambientes sem history: segue só com o fetch */
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/dashboard/period-panel?${search}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        const body = (await res.json()) as { data?: PeriodPanelResult; error?: { message?: string } };
        if (!res.ok || !body.data) {
          throw new Error(body.error?.message ?? `Falha ao carregar o painel (${res.status}).`);
        }
        setResult(body.data);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (abortRef.current === controller) setLoading(false);
      });
    return () => controller.abort();
  }, [query]);

  const data = result.data ?? null;
  const dias = query.mes === "todos" ? 31 : daysInMonthOf(query.ano, query.mes);
  const anos = [...new Set([...(data?.availableYears ?? []), query.ano])].sort((a, b) => a - b);

  function update(patch: Partial<PanelQueryState>) {
    setQuery((prev) => {
      const next = { ...prev, ...patch };
      // Ajuste automático ao trocar para mês mais curto; dia inicial ≤ dia final.
      if (next.mes !== "todos") {
        const max = daysInMonthOf(next.ano, next.mes);
        next.de = Math.min(Math.max(next.de, 1), max);
        next.ate = Math.min(Math.max(next.ate, 1), max);
        if (patch.de !== undefined && next.de > next.ate) next.ate = next.de;
        if (patch.ate !== undefined && next.ate < next.de) next.de = next.ate;
      }
      // Trocar o centro reinicia a categoria (a lista é em cascata).
      if (patch.cc !== undefined && patch.cc !== prev.cc) next.cat = "";
      return next;
    });
  }

  const totals = data?.totals;
  const semMovimento =
    !totals ||
    (totals.receivedCents === 0 &&
      totals.paidCents === 0 &&
      totals.fixedCents === 0 &&
      totals.variableCents === 0);
  const centroSelecionado = data?.costCenters.find((c) => c.id === query.cc);
  const categoriasDoCentro = data?.categories ?? [];

  return (
    <Card
      title={`Painel por Período — regime de caixa${data ? ` · ${data.period.label}` : ""}`}
      className="mb-4"
      id="painel-periodo"
    >
      <form
        className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Filtros do painel por período"
      >
        <label className="text-xs text-[var(--ink-muted)]">
          Ano
          <select
            name="ano"
            className={`${selectClass} mt-0.5 block w-full`}
            value={query.ano}
            onChange={(e) => update({ ano: Number(e.target.value) })}
          >
            {anos.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--ink-muted)]">
          Mês
          <select
            name="mes"
            className={`${selectClass} mt-0.5 block w-full`}
            value={String(query.mes)}
            onChange={(e) => update({ mes: e.target.value === "todos" ? "todos" : Number(e.target.value) })}
          >
            <option value="todos">Todos</option>
            {MONTH_LABELS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--ink-muted)]">
          Dia inicial
          <select
            name="de"
            className={`${selectClass} mt-0.5 block w-full`}
            value={query.de}
            disabled={query.mes === "todos"}
            onChange={(e) => update({ de: Number(e.target.value) })}
          >
            {range(1, dias).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--ink-muted)]">
          Dia final
          <select
            name="ate"
            className={`${selectClass} mt-0.5 block w-full`}
            value={query.ate}
            disabled={query.mes === "todos"}
            onChange={(e) => update({ ate: Number(e.target.value) })}
          >
            {range(1, dias).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--ink-muted)]">
          Centro de Custo
          <select
            name="cc"
            className={`${selectClass} mt-0.5 block w-full`}
            value={query.cc}
            onChange={(e) => update({ cc: e.target.value })}
          >
            <option value="">Todos</option>
            {(data?.costCenters ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--ink-muted)]">
          Categoria
          <select
            name="cat"
            className={`${selectClass} mt-0.5 block w-full`}
            value={query.cat}
            onChange={(e) => update({ cat: e.target.value })}
          >
            <option value="">Todos</option>
            {categoriasDoCentro.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category}
              </option>
            ))}
          </select>
        </label>
      </form>

      <p className="mb-3 min-h-4 text-xs text-[var(--ink-muted)]" aria-live="polite">
        {loading ? "Atualizando…" : error ? <span className="text-[var(--crit)]">{error}</span> : null}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="painel-totais">
        <StatCard
          label="Total Recebido no período"
          value={totals ? formatBRL(totals.receivedCents) : "—"}
          tone="ok"
          hint={totals ? `${totals.receivedCount} recebimento(s)` : undefined}
        />
        <StatCard
          label="Total Pago no período"
          value={totals ? formatBRL(totals.paidCents) : "—"}
          tone="crit"
          hint={
            totals
              ? `${totals.paidCount} pagamento(s)${
                  totals.unclassifiedCents > 0
                    ? ` · Não classificado: ${formatBRL(totals.unclassifiedCents)}`
                    : ""
                }`
              : undefined
          }
        />
        <StatCard
          label="Custo Fixo pago"
          value={totals ? formatBRL(totals.fixedCents) : "—"}
          hint="Classificação do custo = Custo Fixo"
        />
        <StatCard
          label="Custo Variável pago"
          value={totals ? formatBRL(totals.variableCents) : "—"}
          hint="Classificação do custo = Custo Variável"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div>
          {semMovimento ? (
            <EmptyState message="Sem movimentação no período selecionado" />
          ) : (
            <LabeledBarChart
              bars={[
                { label: "Recebido", valueCents: totals!.receivedCents, tone: "ok" },
                { label: "Pago", valueCents: totals!.paidCents, tone: "crit" },
                { label: "Custo Fixo pago", valueCents: totals!.fixedCents, tone: "brand" },
                { label: "Custo Variável pago", valueCents: totals!.variableCents, tone: "warn" },
              ]}
            />
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Total Gasto no Centro de Custo"
            value={data ? formatBRL(data.costCenterTotalCents) : "—"}
            hint={
              centroSelecionado
                ? `${centroSelecionado.code} — ${centroSelecionado.name}`
                : `Todos os centros${data && data.byCostCenter.length > 0 ? ` (${data.byCostCenter.length} com movimento)` : ""}`
            }
          />
          <StatCard
            label="Total Gasto por Categoria"
            value={data ? formatBRL(data.categoryTotalCents) : "—"}
            hint={query.cat ? query.cat : "Todas as categorias do centro"}
            details={
              !query.cat && categoriasDoCentro.length > 0 ? (
                <ol className="space-y-0.5" data-testid="ranking-categorias">
                  {categoriasDoCentro.map((c) => (
                    <li key={c.category} className="flex justify-between gap-2">
                      <span className="truncate">{c.category}</span>
                      <span className="tabular whitespace-nowrap text-[var(--ink)]">
                        {formatBRL(c.totalCents)} · {c.percentOfCenter.toLocaleString("pt-BR")}%
                      </span>
                    </li>
                  ))}
                </ol>
              ) : undefined
            }
            detailsLabel="Ranking das categorias"
          />
        </div>
      </div>

      <SkillResultMeta result={result} />
    </Card>
  );
}
