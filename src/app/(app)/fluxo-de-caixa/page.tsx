import Link from "next/link";
import { Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import type { ISODate } from "@/core/dates";
import { formatBR, formatBRL } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { BalanceLineChart } from "../_lib/charts";
import { runSkillForSession } from "../_lib/run-skill";
import {
  asStringList,
  isSkillError,
  SkillResultMeta,
  SkillUnavailableCard,
} from "../_lib/result-meta";

type Granularity = "daily" | "weekly" | "monthly";

const GRANULARITY_LABEL: Record<Granularity, string> = {
  daily: "Diário",
  weekly: "Semanal",
  monthly: "Mensal",
};

// Formas defensivas dos contratos das skills (escritas em paralelo).
interface BucketView {
  label?: string;
  start?: ISODate;
  end?: ISODate;
  realizedInCents?: number;
  realizedOutCents?: number;
  projectedInCents?: number;
  projectedOutCents?: number;
  netCents?: number;
  cumulativeBalanceCents?: number;
}

interface StatementView {
  buckets?: BucketView[];
  formula?: string;
  period?: { start?: ISODate; end?: ISODate };
}

interface ProjectionView {
  summary?: {
    horizonStart?: ISODate;
    horizonEnd?: ISODate;
    openingBalanceCents?: number;
    endingBalanceCents?: number;
    minBalanceCents?: number;
    minBalanceDate?: ISODate;
  };
  daily?: Array<{ date?: ISODate; balanceCents?: number }>;
  recommendations?: unknown;
}

interface ScenarioView {
  name?: string;
  endingBalanceCents?: number;
  minBalanceCents?: number;
  minBalanceDate?: ISODate;
  params?: unknown;
}

interface ScenariosView {
  scenarios?: ScenarioView[];
  formula?: string;
}

const SCENARIO_LABEL: Record<string, string> = {
  otimista: "Otimista",
  base: "Base",
  pessimista: "Pessimista",
};

function scenarioParamsText(params: unknown): string {
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof p.realizationPercent === "number") {
      parts.push(`realização das entradas: ${p.realizationPercent}%`);
    }
    if (typeof p.delayDays === "number") parts.push(`atraso médio: ${p.delayDays} dias`);
    if (typeof p.overdueDelayDays === "number") {
      parts.push(`vencidos recebidos em: ${p.overdueDelayDays} dias`);
    }
    if (parts.length > 0) return parts.join(" · ");
    return Object.entries(p)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");
  }
  return "";
}

export default async function FluxoDeCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{ g?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const g: Granularity = sp.g === "daily" || sp.g === "monthly" ? sp.g : "weekly";

  const statementRes = await runSkillForSession<StatementView>(session, "tesouraria_fluxo_caixa", {
    action: "cashflow_statement",
    granularity: g,
  });
  const projectionRes = await runSkillForSession<ProjectionView>(
    session,
    "tesouraria_fluxo_caixa",
    { action: "refresh_projection", horizonDays: 90 }
  );
  const scenariosRes = await runSkillForSession<ScenariosView>(session, "tesouraria_fluxo_caixa", {
    action: "scenarios",
  });

  const buckets = statementRes.data?.buckets ?? [];
  const summary = projectionRes.data?.summary;
  const points = (projectionRes.data?.daily ?? [])
    .filter(
      (d): d is { date: ISODate; balanceCents: number } =>
        typeof d?.date === "string" && typeof d?.balanceCents === "number"
    )
    .map((d) => ({ date: d.date, valueCents: d.balanceCents }));
  const scenarios = scenariosRes.data?.scenarios ?? [];
  const recommendations = asStringList(projectionRes.data?.recommendations);

  return (
    <div>
      <PageHeader
        title="Fluxo de caixa"
        subtitle="Realizado, projeção de 90 dias e cenários de tesouraria"
        actions={
          <nav className="flex items-center gap-1" aria-label="Granularidade">
            {(Object.keys(GRANULARITY_LABEL) as Granularity[]).map((key) => (
              <Link
                key={key}
                href={`/fluxo-de-caixa?g=${key}`}
                className={
                  key === g
                    ? "rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand-ink)]"
                    : "rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-slate-50"
                }
              >
                {GRANULARITY_LABEL[key]}
              </Link>
            ))}
          </nav>
        }
      />

      {isSkillError(statementRes) ? (
        <SkillUnavailableCard title={`Demonstrativo (${GRANULARITY_LABEL[g].toLowerCase()})`} result={statementRes} />
      ) : (
        <Card title={`Demonstrativo de fluxo de caixa — ${GRANULARITY_LABEL[g].toLowerCase()}`}>
          {buckets.length === 0 ? (
            <EmptyState message="Sem movimentos no período analisado." />
          ) : (
            <Table
              headers={[
                "Período",
                "Entradas realizadas",
                "Saídas realizadas",
                "Entradas previstas",
                "Saídas previstas",
                "Líquido",
                "Saldo acumulado",
              ]}
              align={["l", "r", "r", "r", "r", "r", "r"]}
            >
              {buckets.map((b, i) => {
                const net = b.netCents ?? 0;
                const cumulative = b.cumulativeBalanceCents ?? 0;
                return (
                  <tr key={`${b.label}-${i}`}>
                    <Td>
                      <span className="font-medium">{b.label ?? "—"}</span>
                      {b.start && b.end ? (
                        <span className="block text-xs text-[var(--ink-muted)]">
                          {formatBR(b.start)} a {formatBR(b.end)}
                        </span>
                      ) : null}
                    </Td>
                    <Td right>{formatBRL(b.realizedInCents ?? 0)}</Td>
                    <Td right>{formatBRL(b.realizedOutCents ?? 0)}</Td>
                    <Td right>{formatBRL(b.projectedInCents ?? 0)}</Td>
                    <Td right>{formatBRL(b.projectedOutCents ?? 0)}</Td>
                    <Td right className={net < 0 ? "text-[var(--crit)]" : "text-[var(--ok)]"}>
                      {formatBRL(net)}
                    </Td>
                    <Td
                      right
                      className={`font-semibold ${cumulative < 0 ? "text-[var(--crit)]" : ""}`}
                    >
                      {formatBRL(cumulative)}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
          {statementRes.data?.formula ? (
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              Fórmula: <code>{statementRes.data.formula}</code>
            </p>
          ) : null}
          <SkillResultMeta result={statementRes} />
        </Card>
      )}

      <div className="mt-4">
        {isSkillError(projectionRes) ? (
          <SkillUnavailableCard title="Projeção de saldo — 90 dias" result={projectionRes} />
        ) : (
          <Card title="Projeção de saldo — 90 dias">
            <BalanceLineChart points={points} />
            {summary ? (
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span>
                  Saldo final projetado:{" "}
                  <strong className="tabular">{formatBRL(summary.endingBalanceCents ?? 0)}</strong>
                </span>
                <span>
                  Menor saldo:{" "}
                  <strong
                    className={`tabular ${(summary.minBalanceCents ?? 0) < 0 ? "text-[var(--crit)]" : ""}`}
                  >
                    {formatBRL(summary.minBalanceCents ?? 0)}
                  </strong>{" "}
                  {summary.minBalanceDate ? `em ${formatBR(summary.minBalanceDate)}` : ""}
                </span>
                {summary.horizonStart && summary.horizonEnd ? (
                  <span className="text-[var(--ink-muted)]">
                    Período: {formatBR(summary.horizonStart)} a {formatBR(summary.horizonEnd)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {recommendations.length > 0 ? (
              <div className="mt-3 text-sm">
                <p className="font-medium">Recomendações</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {recommendations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <SkillResultMeta result={projectionRes} />
          </Card>
        )}
      </div>

      <div className="mt-4">
        {isSkillError(scenariosRes) ? (
          <SkillUnavailableCard title="Cenários" result={scenariosRes} />
        ) : (
          <Card title="Cenários de projeção">
            {scenarios.length === 0 ? (
              <EmptyState message="Nenhum cenário calculado." />
            ) : (
              <div className="grid gap-3 md:grid-cols-3">
                {scenarios.map((s, i) => {
                  const min = s.minBalanceCents ?? 0;
                  return (
                    <div key={`${s.name}-${i}`} className="rounded-lg border border-[var(--line)] p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                        {SCENARIO_LABEL[s.name ?? ""] ?? s.name ?? `Cenário ${i + 1}`}
                      </p>
                      <p className="tabular mt-1 text-xl font-semibold">
                        {formatBRL(s.endingBalanceCents ?? 0)}
                      </p>
                      <p className="mt-1 text-sm">
                        Menor saldo:{" "}
                        <span className={`tabular font-medium ${min < 0 ? "text-[var(--crit)]" : ""}`}>
                          {formatBRL(min)}
                        </span>
                        {s.minBalanceDate ? (
                          <span className="text-[var(--ink-muted)]"> em {formatBR(s.minBalanceDate)}</span>
                        ) : null}
                      </p>
                      {scenarioParamsText(s.params) ? (
                        <p className="mt-2 text-xs text-[var(--ink-muted)]">
                          {scenarioParamsText(s.params)}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {scenariosRes.data?.formula ? (
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                Fórmula: <code>{scenariosRes.data.formula}</code>
              </p>
            ) : null}
            <SkillResultMeta result={scenariosRes} />
          </Card>
        )}
      </div>
    </div>
  );
}
