import { Card, EmptyState, PageHeader } from "@/components/ui";
import { todayInTz, type ISOMonth } from "@/core/dates";
import { getContainer } from "@/lib/container";
import { formatBRL } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { formatMonthBR, isISOMonth, MonthNav } from "../_lib/month-nav";
import { runSkillForSession } from "../_lib/run-skill";
import { isSkillError, SkillResultMeta, SkillUnavailableCard } from "../_lib/result-meta";

// Forma defensiva do contrato de controladoria_indicadores (escrita em paralelo).
interface IndicatorView {
  key?: string;
  label?: string;
  valueCents?: number | null;
  valuePercent?: number | null;
  valueDays?: number | null;
  formula?: string;
  explanation?: string;
  period?: string;
}

interface IndicatorsDataView {
  period?: ISOMonth;
  /** Contrato: array ou objeto — tratar ambos. */
  indicators?: unknown;
  regime?: string;
}

const PERCENT_FMT = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Array ou objeto {chave: indicador} → lista normalizada. */
function normalizeIndicators(raw: unknown): IndicatorView[] {
  if (Array.isArray(raw)) {
    return raw.filter((i): i is IndicatorView => i !== null && typeof i === "object");
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, IndicatorView] => e[1] !== null && typeof e[1] === "object")
      .map(([key, value]) => ({ key, ...value }));
  }
  return [];
}

function indicatorValue(i: IndicatorView): string {
  if (typeof i.valueCents === "number") return formatBRL(i.valueCents);
  if (typeof i.valuePercent === "number") return `${PERCENT_FMT.format(i.valuePercent)}%`;
  if (typeof i.valueDays === "number") return `${Math.round(i.valueDays)} dias`;
  return "—";
}

export default async function IndicadoresPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const { clock } = await getContainer();
  const sp = await searchParams;
  const currentMonth = todayInTz(clock.now(), session.config.timezone).slice(0, 7);
  const period: ISOMonth = isISOMonth(sp.period) ? sp.period : currentMonth;

  const res = await runSkillForSession<IndicatorsDataView>(session, "controladoria_indicadores", {
    action: "indicators",
    period,
  });

  const indicators = normalizeIndicators(res.data?.indicators);

  return (
    <div>
      <PageHeader
        title="Indicadores financeiros"
        subtitle={`Indicadores gerenciais de ${formatMonthBR(period)}, com fórmula e explicação`}
      />

      <div className="mb-4">
        <MonthNav basePath="/indicadores" selected={period} latest={currentMonth} />
      </div>

      {isSkillError(res) ? (
        <SkillUnavailableCard title={`Indicadores de ${formatMonthBR(period)}`} result={res} />
      ) : indicators.length === 0 ? (
        <Card>
          <EmptyState message="Nenhum indicador calculado para o período." />
          <SkillResultMeta result={res} />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {indicators.map((i, idx) => (
              <div key={i.key ?? idx} className="card p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
                  {i.label ?? i.key ?? `Indicador ${idx + 1}`}
                </p>
                <p
                  className={`tabular mt-1 text-2xl font-semibold ${
                    typeof i.valueCents === "number" && i.valueCents < 0
                      ? "text-[var(--crit)]"
                      : ""
                  }`}
                >
                  {indicatorValue(i)}
                </p>
                {i.formula ? (
                  <p className="mt-2">
                    <code className="block rounded bg-slate-50 px-2 py-1 text-[11px] text-[var(--ink-muted)]">
                      {i.formula}
                    </code>
                  </p>
                ) : null}
                {i.explanation ? (
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">{i.explanation}</p>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-4">
            <Card>
              <SkillResultMeta result={res} />
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                Período de apuração: {formatMonthBR(res.data?.period ?? period)} · regime de
                competência.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
