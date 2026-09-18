import { Card, PageHeader, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import { getCashflowVariance } from "@/app/api/_lib/cashflow";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { BASE, ComputedAt, FluxoTabs, MESES_CURTOS, YearSelect, cell } from "../_lib/shared";

/**
 * Previsto × Realizado — para Total de Entradas, Total de Saídas e cada grupo
 * de saída: previsto, realizado e variação (= realizado − previsto) por mês.
 * Variação relevante (destacada) = |variação| ≥ limiar absoluto E, quando há
 * previsto, |variação ÷ previsto| ≥ limiar percentual. Os limiares são da
 * tela (query), não do cálculo.
 */
export default async function PrevistoRealizadoPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; pct?: string; abs?: string; ok?: string; erro?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const container = await getContainer();
  const data = await getCashflowVariance(container, session, sp.ano ? { ano: sp.ano } : {});
  const pct = Number.isFinite(Number(sp.pct)) && sp.pct ? Math.max(0, Number(sp.pct)) : 10;
  const absReais = Number.isFinite(Number(sp.abs)) && sp.abs ? Math.max(0, Number(sp.abs)) : 1000;
  const absCents = Math.round(absReais * 100);

  const relevante = (variacao: number, previsto: number): boolean => {
    if (Math.abs(variacao) < absCents) return false;
    if (previsto === 0) return true;
    return Math.abs(variacao) * 100 >= Math.abs(previsto) * pct;
  };
  // Em saídas, variação positiva = gasto acima do planejado (ruim); em entradas, negativa = receita abaixo.
  const tom = (kind: "entrada" | "saida", variacao: number): string =>
    variacao === 0 ? "" : (kind === "saida" ? variacao > 0 : variacao < 0) ? "text-[var(--crit)]" : "text-[var(--ok)]";

  const numCls = "tabular whitespace-nowrap px-2 py-1 text-right text-xs";
  const labelCls = "whitespace-nowrap px-2 py-1 text-xs";

  return (
    <div>
      <PageHeader
        title="Previsto × Realizado"
        subtitle={`Ano base ${data.year} — variação = realizado − previsto. Em saídas, variação positiva significa gasto acima do planejado.`}
        actions={<YearSelect ano={data.year} years={data.years} path={`${BASE}/previsto-realizado`} extra={{ pct: sp.pct, abs: sp.abs }} />}
      />
      <FluxoTabs active="previsto-realizado" ano={data.year} />
      <Flash ok={sp.ok} erro={sp.erro} />

      <Card className="mb-4" title="Destaque de variação relevante">
        <form method="get" action={`${BASE}/previsto-realizado`} className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="ano" value={data.year} />
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--ink-muted)]">Acima de (%)</span>
            <input name="pct" type="number" min={0} step={1} defaultValue={pct} className={`${inputClass} !w-28`} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--ink-muted)]">ou valor absoluto (R$)</span>
            <input name="abs" type="number" min={0} step={100} defaultValue={absReais} className={`${inputClass} !w-36`} />
          </label>
          <button type="submit" className="rounded-lg border border-[var(--line)] px-3 py-1.5 hover:bg-slate-50">
            Aplicar
          </button>
          <span className="text-xs text-[var(--ink-muted)]">Destaca quando |variação| ≥ R$ {absReais.toLocaleString("pt-BR")} e, havendo previsto, ≥ {pct}% dele.</span>
        </form>
      </Card>

      <Card className="mb-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="previsto-realizado">
            <thead>
              <tr className="border-b border-[var(--line)] text-xs uppercase tracking-wide text-[var(--ink-muted)]">
                <th className="px-2 py-2 text-left font-medium">Linha</th>
                <th className="px-2 py-2 text-left font-medium">Visão</th>
                {MESES_CURTOS.map((h) => (
                  <th key={h} className="px-2 py-2 text-right font-medium">{h}</th>
                ))}
                <th className="px-2 py-2 text-right font-medium">Ano</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {data.variance.lines.map((l) => (
                <RowsFragment key={l.key}>
                  <tr className={l.key === "entradas" || l.key === "saidas" ? "bg-slate-50" : ""}>
                    <td className={`${labelCls} font-medium`} rowSpan={3}>{l.label}</td>
                    <td className={`${labelCls} text-[var(--ink-muted)]`}>Previsto</td>
                    {l.previsto.map((v, i) => (
                      <td key={i} className={numCls}>{cell(v)}</td>
                    ))}
                    <td className={`${numCls} font-medium`}>{cell(l.previstoAnoCents)}</td>
                  </tr>
                  <tr className={l.key === "entradas" || l.key === "saidas" ? "bg-slate-50" : ""}>
                    <td className={`${labelCls} text-[var(--ink-muted)]`}>Realizado</td>
                    {l.realizado.map((v, i) => (
                      <td key={i} className={numCls}>{cell(v)}</td>
                    ))}
                    <td className={`${numCls} font-medium`}>{cell(l.realizadoAnoCents)}</td>
                  </tr>
                  <tr className={l.key === "entradas" || l.key === "saidas" ? "bg-slate-50" : ""}>
                    <td className={`${labelCls} text-[var(--ink-muted)]`}>Variação</td>
                    {l.variacao.map((v, i) => (
                      <td
                        key={i}
                        className={`${numCls} ${tom(l.kind, v)} ${relevante(v, l.previsto[i]) ? "rounded bg-amber-100 font-semibold" : ""}`}
                        title={relevante(v, l.previsto[i]) ? "Variação relevante" : undefined}
                      >
                        {cell(v)}
                      </td>
                    ))}
                    <td className={`${numCls} font-medium ${tom(l.kind, l.variacaoAnoCents)}`}>{cell(l.variacaoAnoCents)}</td>
                  </tr>
                </RowsFragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          Previsto = Σ lançamentos com status previsto; Realizado = Σ com status realizado; Variação = Realizado − Previsto.
          Total do ano: {formatBRL(data.variance.lines[0]?.realizadoAnoCents ?? 0)} realizados em entradas e{" "}
          {formatBRL(data.variance.lines[1]?.realizadoAnoCents ?? 0)} em saídas.
        </p>
        <ComputedAt iso={data.computedAt} />
      </Card>
    </div>
  );
}

function RowsFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
