import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatBR, todayInTz, type ISODate, type ISOMonth } from "@/core/dates";
import { getContainer } from "@/lib/container";
import { formatBRL } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { formatMonthBR, isISOMonth, MonthNav } from "../_lib/month-nav";
import { runSkillForSession } from "../_lib/run-skill";
import {
  asStringList,
  isSkillError,
  SkillResultMeta,
  SkillUnavailableCard,
} from "../_lib/result-meta";

// Formas defensivas do contrato de relatorios_gerenciais (escrita em paralelo).
interface DailySummaryView {
  date?: ISODate;
  facts?: Record<string, unknown>;
  calculations?: Record<string, unknown>;
  risks?: unknown;
  recommendations?: unknown;
}

interface MonthlyCloseView {
  period?: ISOMonth;
  facts?: Record<string, unknown>;
  calculations?: Record<string, unknown> & {
    dreSimplificada?: {
      regime?: string;
      receitaCents?: number;
      despesasCents?: number;
      resultadoCents?: number;
      formula?: string;
    };
  };
  highlights?: unknown;
  risks?: unknown;
  recommendations?: unknown;
}

interface ExecutiveOverviewView {
  asOf?: ISODate;
  kpis?: Array<{ code?: string; label?: string; value?: number; unit?: string }>;
  trend?: {
    direction?: string;
    variationPercent?: number | null;
    lastMonth?: ISOMonth;
    formula?: string;
  };
  risks?: unknown;
  opportunities?: unknown;
  recommendations?: unknown;
}

const FACT_LABELS: Record<string, string> = {
  availableCents: "Saldo disponível",
  payablesDueTodayCents: "A pagar hoje",
  payablesDueTodayCount: "Títulos a pagar hoje",
  receivablesDueTodayCents: "A receber hoje",
  receivablesDueTodayCount: "Títulos a receber hoje",
  overduePayablesCents: "Pagáveis vencidos",
  overdueReceivablesCents: "Recebíveis vencidos",
  openAlerts: "Alertas abertos",
  pendingApprovals: "Aprovações pendentes",
  receiptsCents: "Recebimentos no mês",
  paymentsCents: "Pagamentos no mês",
  newPayablesCents: "Novos títulos a pagar",
  newReceivablesCents: "Novos títulos a receber",
  endOfMonthAvailableCents: "Saldo ao fim do mês",
  projected7dEndingBalanceCents: "Saldo projetado em 7 dias",
  netCashFlowCents: "Fluxo de caixa líquido",
};

const SUBKEY_LABELS: Record<string, string> = {
  critical: "críticos",
  warning: "atenção",
  info: "info",
};

/** Formata um fato de forma genérica: *Cents → BRL; número → pt-BR; objeto → pares. */
function formatFact(key: string, value: unknown): string {
  if (typeof value === "number") {
    if (key.endsWith("Cents")) return formatBRL(value);
    return value.toLocaleString("pt-BR");
  }
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === "number" || typeof v === "string")
      .map(([k, v]) => `${String(v)} ${SUBKEY_LABELS[k] ?? k}`)
      .join(" · ");
  }
  return "—";
}

function FactsList({ facts }: { facts: Record<string, unknown> | undefined }) {
  if (!facts || Object.keys(facts).length === 0) {
    return <EmptyState message="Sem fatos calculados." />;
  }
  return (
    <dl className="space-y-1 text-sm">
      {Object.entries(facts).map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-3">
          <dt className="text-[var(--ink-muted)]">{FACT_LABELS[key] ?? key}</dt>
          <dd className="tabular text-right font-medium">{formatFact(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function BulletList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 text-sm">
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function DownloadLinks({ report, period }: { report: string; period?: string }) {
  const href = (format: string) =>
    `/api/v1/reports/${report}?format=${format}${period ? `&period=${period}` : ""}`;
  const cls =
    "inline-flex items-center rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--ink)] hover:bg-slate-50";
  return (
    <div className="mt-4 flex gap-2">
      <a href={href("csv")} className={cls}>
        Baixar CSV
      </a>
      <a href={href("pdf")} className={cls}>
        Baixar PDF
      </a>
    </div>
  );
}

const TREND_LABEL: Record<string, string> = {
  alta: "Em alta",
  "estável": "Estável",
  queda: "Em queda",
};

export default async function RelatoriosPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const { clock } = await getContainer();
  const sp = await searchParams;
  const currentMonth = todayInTz(clock.now(), session.config.timezone).slice(0, 7);
  const period: ISOMonth = isISOMonth(sp.period) ? sp.period : currentMonth;

  const dailyRes = await runSkillForSession<DailySummaryView>(session, "relatorios_gerenciais", {
    action: "daily_summary",
  });
  const monthlyRes = await runSkillForSession<MonthlyCloseView>(session, "relatorios_gerenciais", {
    action: "monthly_close",
    period,
  });
  const overviewRes = await runSkillForSession<ExecutiveOverviewView>(
    session,
    "relatorios_gerenciais",
    { action: "executive_overview" }
  );

  const dre = monthlyRes.data?.calculations?.dreSimplificada;
  const trend = overviewRes.data?.trend;

  return (
    <div>
      <PageHeader
        title="Relatórios gerenciais"
        subtitle="Resumo diário, fechamento mensal e visão executiva — com download em CSV e PDF"
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Resumo diário */}
        {isSkillError(dailyRes) ? (
          <SkillUnavailableCard title="Resumo diário" result={dailyRes} />
        ) : (
          <Card title="Resumo diário">
            {dailyRes.data?.date ? (
              <p className="mb-2 text-xs text-[var(--ink-muted)]">
                Data de referência: {formatBR(dailyRes.data.date)}
              </p>
            ) : null}
            <FactsList facts={dailyRes.data?.facts} />
            <BulletList title="Riscos" items={asStringList(dailyRes.data?.risks)} />
            <BulletList
              title="Recomendações"
              items={asStringList(dailyRes.data?.recommendations)}
            />
            <DownloadLinks report="daily_summary" />
            <SkillResultMeta result={dailyRes} />
          </Card>
        )}

        {/* Fechamento mensal */}
        <Card title={`Fechamento mensal — ${formatMonthBR(period)}`}>
          <div className="mb-3">
            <MonthNav basePath="/relatorios" selected={period} latest={currentMonth} count={6} />
          </div>
          {isSkillError(monthlyRes) ? (
            <p className="text-sm text-[var(--ink-muted)]">
              Skill em implementação.
              {monthlyRes?.alerts?.[0]?.message ? ` ${monthlyRes.alerts[0].message}` : ""}
            </p>
          ) : (
            <>
              <FactsList facts={monthlyRes.data?.facts} />
              {dre ? (
                <div className="mt-3 rounded-lg border border-[var(--line)] p-3 text-sm">
                  <p className="mb-1 flex items-center gap-2 font-medium">
                    DRE simplificada <Badge tone="neutral">regime de caixa</Badge>
                  </p>
                  <dl className="space-y-1">
                    <div className="flex justify-between">
                      <dt className="text-[var(--ink-muted)]">Receita</dt>
                      <dd className="tabular font-medium">{formatBRL(dre.receitaCents ?? 0)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[var(--ink-muted)]">Despesas</dt>
                      <dd className="tabular font-medium">{formatBRL(dre.despesasCents ?? 0)}</dd>
                    </div>
                    <div className="flex justify-between border-t border-[var(--line)] pt-1">
                      <dt className="font-semibold">Resultado</dt>
                      <dd
                        className={`tabular font-semibold ${
                          (dre.resultadoCents ?? 0) < 0 ? "text-[var(--crit)]" : ""
                        }`}
                      >
                        {formatBRL(dre.resultadoCents ?? 0)}
                      </dd>
                    </div>
                  </dl>
                  {dre.formula ? (
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                      Fórmula: <code>{dre.formula}</code>
                    </p>
                  ) : null}
                </div>
              ) : null}
              <BulletList title="Destaques" items={asStringList(monthlyRes.data?.highlights)} />
              <BulletList title="Riscos" items={asStringList(monthlyRes.data?.risks)} />
              <BulletList
                title="Recomendações"
                items={asStringList(monthlyRes.data?.recommendations)}
              />
              <DownloadLinks report="monthly_close" period={period} />
              <SkillResultMeta result={monthlyRes} />
            </>
          )}
        </Card>

        {/* Visão executiva */}
        {isSkillError(overviewRes) ? (
          <SkillUnavailableCard title="Visão executiva" result={overviewRes} />
        ) : (
          <Card title="Visão executiva">
            {overviewRes.data?.asOf ? (
              <p className="mb-2 text-xs text-[var(--ink-muted)]">
                Posição em {formatBR(overviewRes.data.asOf)}
              </p>
            ) : null}
            {(overviewRes.data?.kpis ?? []).length > 0 ? (
              <dl className="space-y-1 text-sm">
                {(overviewRes.data?.kpis ?? []).map((k, i) => (
                  <div key={k.code ?? i} className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--ink-muted)]">{k.label ?? k.code ?? "KPI"}</dt>
                    <dd className="tabular text-right font-medium">
                      {typeof k.value === "number"
                        ? k.unit === "centavos_brl"
                          ? formatBRL(k.value)
                          : k.value.toLocaleString("pt-BR")
                        : "—"}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <EmptyState message="Sem KPIs calculados." />
            )}
            {trend ? (
              <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Tendência de entradas:</span>
                <Badge
                  tone={
                    trend.direction === "alta"
                      ? "ok"
                      : trend.direction === "queda"
                        ? "crit"
                        : "neutral"
                  }
                >
                  {TREND_LABEL[trend.direction ?? ""] ?? trend.direction ?? "—"}
                </Badge>
                {typeof trend.variationPercent === "number" ? (
                  <span className="tabular text-[var(--ink-muted)]">
                    {trend.variationPercent.toLocaleString("pt-BR", {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                    % vs. média dos 2 meses anteriores
                  </span>
                ) : null}
              </p>
            ) : null}
            <BulletList title="Riscos" items={asStringList(overviewRes.data?.risks)} />
            <BulletList
              title="Oportunidades"
              items={asStringList(overviewRes.data?.opportunities)}
            />
            <BulletList
              title="Recomendações"
              items={asStringList(overviewRes.data?.recommendations)}
            />
            <DownloadLinks report="executive_overview" />
            <SkillResultMeta result={overviewRes} />
          </Card>
        )}
      </div>
    </div>
  );
}
