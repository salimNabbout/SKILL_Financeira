import Link from "next/link";
import { Badge, Card, PageHeader, StatCard } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import { CASH_SITUATION_LABEL, monthLabel, type CashSituation } from "@/core/cashflow";
import { getCashflowDashboard } from "@/app/api/_lib/cashflow";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { LabeledBarChart } from "@/app/(app)/_lib/charts";
import { MultiLineChart } from "./_lib/charts";
import { BASE, ComputedAt, FluxoTabs, MESES_CURTOS, HeaderActions } from "./_lib/shared";

const SITUACAO_TONE: Record<CashSituation, "ok" | "warn" | "crit"> = { ok: "ok", abaixo_reserva: "warn", caixa_negativo: "crit" };
const SEV_TONE = { info: "neutral", warning: "warn", critical: "crit" } as const;
const SEV_LABEL = { info: "Informativo", warning: "Atenção", critical: "Crítico" } as const;
const SCEN_TONE = { otimista: "ok", realista: "brand", pessimista: "crit" } as const;

/**
 * Dashboard do Fluxo de Caixa — KPIs, gráfico entradas/saídas/saldo, composição
 * das saídas por grupo, saldo projetado nos três cenários e alertas
 * acionáveis. Sempre com o carimbo do cálculo.
 */
export default async function FluxoCaixaDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; ok?: string; erro?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const container = await getContainer();
  const d = await getCashflowDashboard(container, session, sp.ano ? { ano: sp.ano } : {});
  const situacaoAno = d.series.mensal[11]?.situacao as CashSituation | undefined;
  const saldoTone = situacaoAno ? SITUACAO_TONE[situacaoAno] : "neutral";
  const monthLabels = MESES_CURTOS.map((m) => `${m}/${String(d.year).slice(2)}`);
  const cenLabels = d.series.cenarios[0]?.months.map((m) => monthLabel(m.month).replace("/20", "/")) ?? [];
  const risco = (code: "otimista" | "realista" | "pessimista") => d.kpis.mesesRisco[code];

  return (
    <div>
      <PageHeader
        title="Fluxo de Caixa CETEM"
        subtitle="Realizado pela conciliação e pelas baixas, previsto pelos títulos em aberto, projeção por cenário — nada digitado, tudo derivado dos módulos."
        actions={<HeaderActions ano={d.year} years={d.years} path={BASE} />}
      />
      <FluxoTabs active="dashboard" ano={d.year} />
      <Flash ok={sp.ok} erro={sp.erro} />

      {d.warnings.length > 0 ? (
        <div className="mb-4 space-y-1">
          {d.warnings.map((w) => (
            <p key={w} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {w}{" "}
              {/não configurados/.test(w) ? <Link href={`${BASE}/parametros?ano=${d.year}`} className="underline">Configurar parâmetros</Link> : null}
            </p>
          ))}
        </div>
      ) : null}
      {d.naoClassificados.count > 0 ? (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {d.naoClassificados.count} lançamento(s) em <strong>A Classificar</strong> ({formatBRL(d.naoClassificados.totalCents)}) —{" "}
          <Link href={`${BASE}/lancamentos?ano=${d.year}`} className="underline">revisar na fila</Link>.
        </p>
      ) : null}

      <div className="mb-4 grid gap-3 md:grid-cols-4" data-testid="fc-kpis">
        <StatCard label="Entradas do ano" value={formatBRL(d.kpis.entradasAnoCents)} tone="ok" hint="Previsto + realizado" />
        <StatCard label="Saídas do ano" value={formatBRL(d.kpis.saidasAnoCents)} tone="crit" hint="Previsto + realizado" />
        <StatCard label="Resultado do ano" value={formatBRL(d.kpis.resultadoAnoCents)} tone={d.kpis.resultadoAnoCents < 0 ? "crit" : "ok"} hint="Entradas − Saídas" />
        <StatCard label="Saldo final do ano" value={formatBRL(d.kpis.saldoFinalAnoCents)} tone={saldoTone} hint={situacaoAno ? `Situação em dezembro: ${CASH_SITUATION_LABEL[situacaoAno]}` : undefined} />
      </div>
      <div className="mb-6 grid gap-3 md:grid-cols-4">
        {(["otimista", "realista", "pessimista"] as const).map((code) => {
          const v = d.kpis.saldo12MesesCents[code];
          const r = risco(code);
          return (
            <StatCard
              key={code}
              label={`Saldo em 12 meses — ${code}`}
              value={v === undefined ? "—" : formatBRL(v)}
              tone={v === undefined ? "neutral" : v < 0 ? "crit" : "neutral"}
              hint={r ? `${r.abaixoReserva} mês(es) abaixo da reserva · ${r.negativos} negativo(s)` : undefined}
            />
          );
        })}
        <StatCard
          label="Meses realizados"
          value={String(d.kpis.realizedMonths)}
          tone={d.kpis.lowConfidence ? "warn" : "neutral"}
          hint={d.kpis.lowConfidence ? "Menos de 3 meses: projeção de baixa confiabilidade" : "Base das médias da projeção"}
        />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title={`Entradas, saídas e saldo — ${d.year}`}>
          <MultiLineChart
            labels={monthLabels}
            ariaLabel="Entradas, saídas e saldo final por mês"
            series={[
              { label: "Entradas", tone: "ok", values: d.series.mensal.map((m) => m.entradasCents) },
              { label: "Saídas", tone: "crit", values: d.series.mensal.map((m) => m.saidasCents) },
              { label: "Saldo final", tone: "brand", values: d.series.mensal.map((m) => m.saldoCents) },
            ]}
          />
        </Card>
        <Card title="Composição das saídas do ano por grupo">
          <LabeledBarChart
            bars={d.series.composicao.map((c) => ({ label: c.label, valueCents: c.totalCents, tone: c.group === "pessoal" ? "brand" : c.group === "tributos" ? "warn" : "crit" }))}
          />
        </Card>
      </div>

      <Card className="mb-6" title="Saldo projetado — três cenários (12 meses)">
        {d.series.cenarios.length === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]">Sem cenários ativos.</p>
        ) : (
          <MultiLineChart
            labels={cenLabels}
            ariaLabel="Saldo projetado por cenário"
            series={d.series.cenarios.map((c) => ({ label: c.name, tone: SCEN_TONE[c.code], values: c.months.map((m) => m.balanceCents), dashed: c.code !== "realista" }))}
          />
        )}
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          Estimativa a partir das médias dos meses realizados e das premissas de cada cenário (Parâmetros). Não é fato realizado.
        </p>
      </Card>

      <Card className="mb-6" title={d.alerts.length === 0 ? "Alertas: nenhum" : `Alertas (${d.alerts.length})`}>
        {d.alerts.length === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]">Nenhum alerta para o ano base com as premissas atuais.</p>
        ) : (
          <ul className="space-y-2" data-testid="fc-alertas">
            {d.alerts.map((a, i) => (
              <li key={`${a.code}-${a.month ?? ""}-${a.categoryId ?? ""}-${i}`} className="flex items-start gap-2 rounded-lg border border-[var(--line)] p-3 text-sm">
                <Badge tone={SEV_TONE[a.severity]}>{SEV_LABEL[a.severity]}</Badge>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ComputedAt iso={d.computedAt} />
    </div>
  );
}
