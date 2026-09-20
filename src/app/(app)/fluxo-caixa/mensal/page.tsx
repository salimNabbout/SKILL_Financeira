import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import { CASH_SITUATION_LABEL, type CashSituation } from "@/core/cashflow";
import { getCashflowMonthly } from "@/app/api/_lib/cashflow";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { BASE, ComputedAt, FluxoTabs, MESES_CURTOS, HeaderActions, cell } from "../_lib/shared";

const SITUACAO_TONE: Record<CashSituation, "ok" | "warn" | "crit"> = {
  ok: "ok",
  abaixo_reserva: "warn",
  caixa_negativo: "crit",
};

/**
 * Fluxo Mensal — grade 12 meses × categorias (aba homônima da planilha):
 * subtotais por grupo colapsáveis (?colapsar=grupo,grupo), linhas fixas de
 * totais, resultado, saldo inicial/final encadeado e semáforo da situação vs.
 * reserva. Sem estado no cliente: colapsar é um link.
 */
export default async function FluxoMensalPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; colapsar?: string; ok?: string; erro?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const container = await getContainer();
  const data = await getCashflowMonthly(container, session, sp.ano ? { ano: sp.ano } : {});
  const m = data.monthly;
  const colapsados = new Set((sp.colapsar ?? "").split(",").filter(Boolean));
  const toggleHref = (group: string) => {
    const next = new Set(colapsados);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    const qs = new URLSearchParams({ ano: String(data.year) });
    if (next.size > 0) qs.set("colapsar", [...next].join(","));
    return `${BASE}/mensal?${qs.toString()}`;
  };
  const headers = ["Categoria", ...MESES_CURTOS, "Total do ano"];
  const numCls = "tabular whitespace-nowrap px-2 py-1 text-right text-xs";
  const labelCls = "whitespace-nowrap px-2 py-1 text-xs";
  const entradas = m.rows.filter((r) => r.kind === "entrada");

  return (
    <div>
      <PageHeader
        title="Fluxo Mensal"
        subtitle={`Ano base ${data.year} — valores em R$, previsto e realizado somados; saldo encadeado mês a mês.`}
        actions={<HeaderActions ano={data.year} years={data.years} path={`${BASE}/mensal`} extra={{ colapsar: sp.colapsar }} />}
      />
      <FluxoTabs active="mensal" ano={data.year} />
      <Flash ok={sp.ok} erro={sp.erro} />
      {!data.parameterConfigured ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Parâmetros do exercício ainda não gravados: saldo inicial 0 e reserva mínima = caixa mínimo da empresa.{" "}
          <Link href={`${BASE}/parametros?ano=${data.year}`} className="underline">Configurar parâmetros</Link>.
        </p>
      ) : null}
      {data.naoClassificados.count > 0 ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {data.naoClassificados.count} lançamento(s) em <strong>A Classificar</strong> ({formatBRL(data.naoClassificados.totalCents)}) —{" "}
          <Link href={`${BASE}/lancamentos?ano=${data.year}`} className="underline">revisar na fila</Link>.
        </p>
      ) : null}

      <Card className="mb-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="fluxo-mensal">
            <thead>
              <tr className="border-b border-[var(--line)] text-xs uppercase tracking-wide text-[var(--ink-muted)]">
                {headers.map((h, i) => (
                  <th key={h} className={`px-2 py-2 font-medium ${i === 0 ? "text-left" : "text-right"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              <tr className="bg-slate-50 font-medium">
                <td className={labelCls} colSpan={14}>Entradas</td>
              </tr>
              {entradas.map((r) => (
                <tr key={r.categoryId}>
                  <td className={`${labelCls} pl-5`}>{r.name}</td>
                  {r.months.map((v, i) => (
                    <td key={i} className={numCls}>{cell(v)}</td>
                  ))}
                  <td className={`${numCls} font-medium`}>{cell(r.totalCents)}</td>
                </tr>
              ))}
              <tr className="bg-emerald-50 font-semibold">
                <td className={labelCls}>Total de Entradas</td>
                {m.entradasTotal.map((v, i) => (
                  <td key={i} className={numCls}>{cell(v)}</td>
                ))}
                <td className={numCls}>{cell(m.entradasAnoCents)}</td>
              </tr>

              {m.saidasGrupos.map((g) => {
                const rows = m.rows.filter((r) => r.kind === "saida" && r.group === g.group);
                const fechado = colapsados.has(g.group);
                return (
                  <FragmentRows key={g.group}>
                    <tr className="bg-slate-50 font-medium">
                      <td className={labelCls}>
                        <Link href={toggleHref(g.group)} className="mr-1 inline-block w-4 text-center text-[var(--brand)]" aria-label={fechado ? `Expandir ${g.label}` : `Recolher ${g.label}`}>
                          {fechado ? "▸" : "▾"}
                        </Link>
                        {g.label}
                        <span className="ml-1 text-[var(--ink-muted)]">({rows.length})</span>
                      </td>
                      {g.months.map((v, i) => (
                        <td key={i} className={numCls}>{cell(v)}</td>
                      ))}
                      <td className={`${numCls} font-semibold`}>{cell(g.totalCents)}</td>
                    </tr>
                    {fechado
                      ? null
                      : rows.map((r) => (
                          <tr key={r.categoryId}>
                            <td className={`${labelCls} pl-5`}>
                              {r.name}
                              <span className="ml-1 text-[10px] uppercase text-[var(--ink-muted)]">{r.classification}</span>
                            </td>
                            {r.months.map((v, i) => (
                              <td key={i} className={numCls}>{cell(v)}</td>
                            ))}
                            <td className={`${numCls} font-medium`}>{cell(r.totalCents)}</td>
                          </tr>
                        ))}
                  </FragmentRows>
                );
              })}
              <tr className="bg-red-50 font-semibold">
                <td className={labelCls}>Total de Saídas</td>
                {m.saidasTotal.map((v, i) => (
                  <td key={i} className={numCls}>{cell(v)}</td>
                ))}
                <td className={numCls}>{cell(m.saidasAnoCents)}</td>
              </tr>
            </tbody>
            <tfoot className="border-t-2 border-[var(--line)] bg-[var(--surface)]">
              <tr className="font-semibold">
                <td className={labelCls}>Resultado do Mês</td>
                {m.resultado.map((v, i) => (
                  <td key={i} className={`${numCls} ${v < 0 ? "text-[var(--crit)]" : ""}`}>{cell(v, false)}</td>
                ))}
                <td className={`${numCls} ${m.resultadoAnoCents < 0 ? "text-[var(--crit)]" : ""}`}>{cell(m.resultadoAnoCents, false)}</td>
              </tr>
              <tr>
                <td className={labelCls}>Saldo Inicial</td>
                {m.saldoInicial.map((v, i) => (
                  <td key={i} className={numCls}>{cell(v, false)}</td>
                ))}
                <td className={numCls}>{cell(m.openingBalanceCents, false)}</td>
              </tr>
              <tr className="font-semibold">
                <td className={labelCls}>Saldo Final</td>
                {m.saldoFinal.map((v, i) => (
                  <td key={i} className={`${numCls} ${v < 0 ? "text-[var(--crit)]" : ""}`} data-testid={`saldo-final-${i + 1}`}>{cell(v, false)}</td>
                ))}
                <td className={`${numCls} ${m.saldoFinal[11] < 0 ? "text-[var(--crit)]" : ""}`}>{cell(m.saldoFinal[11], false)}</td>
              </tr>
              <tr>
                <td className={labelCls}>Situação vs. reserva</td>
                {m.situacao.map((s, i) => (
                  <td key={i} className="px-1 py-1 text-right">
                    <Badge tone={SITUACAO_TONE[s]}>{CASH_SITUATION_LABEL[s]}</Badge>
                  </td>
                ))}
                <td className={`${labelCls} text-right text-[var(--ink-muted)]`}>reserva {formatBRL(m.minimumReserveCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          Fórmulas: valor = Σ lançamentos da categoria no mês (previsto + realizado); Total de Saídas = Σ dos 6 grupos;
          Resultado = Entradas − Saídas; Saldo Inicial (jan) = saldo inicial do parâmetro, (demais) = Saldo Final anterior;
          Saldo Final = Saldo Inicial + Resultado; situação: CAIXA NEGATIVO &lt; 0, Abaixo da reserva &lt; reserva mínima, senão OK.
        </p>
        <ComputedAt iso={data.computedAt} />
      </Card>
    </div>
  );
}

/** Fragmento para agrupar as linhas de um grupo sem um wrapper no DOM. */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
