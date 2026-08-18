import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, StatCard } from "@/components/ui";
import { addDays, todayInTz, type ISODate } from "@/core/dates";
import { getContainer } from "@/lib/container";
import { formatBR, formatBRL, formatDateTime, ROLE_LABELS } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { InOutBarChart, type InOutGroup } from "./_lib/charts";
import { runSkillForSession } from "./_lib/run-skill";
import {
  asStringList,
  isSkillError,
  SkillResultMeta,
  SkillUnavailableCard,
} from "./_lib/result-meta";

// Formas defensivas (contratos das skills escritas em paralelo) — tudo opcional.
interface CashPositionView {
  accounts?: Array<{ id?: string; name?: string; availableCents?: number }>;
  totals?: { availableCents?: number; committedCents?: number; projected30Cents?: number };
}

interface DailyPointView {
  date?: ISODate;
  inCents?: number;
  outCents?: number;
  balanceCents?: number;
}

interface ProjectionView {
  summary?: {
    horizonStart?: ISODate;
    horizonEnd?: ISODate;
    endingBalanceCents?: number;
    minBalanceCents?: number;
    minBalanceDate?: ISODate;
  };
  daily?: DailyPointView[];
  recommendations?: unknown;
}

interface OverviewView {
  risks?: unknown;
  opportunities?: unknown;
  recommendations?: unknown;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const SEVERITY_TONE: Record<string, "crit" | "warn" | "brand"> = {
  critical: "crit",
  warning: "warn",
  info: "brand",
};
const SEVERITY_LABEL: Record<string, string> = {
  critical: "Crítico",
  warning: "Atenção",
  info: "Info",
};

export default async function DashboardPage() {
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const today = todayInTz(clock.now(), session.config.timezone);

  // Skills de leitura em sequência (trilha de auditoria encadeada por hash).
  const cashRes = await runSkillForSession<CashPositionView>(session, "tesouraria_fluxo_caixa", {
    action: "cash_position",
  });
  const projRes = await runSkillForSession<ProjectionView>(session, "tesouraria_fluxo_caixa", {
    action: "refresh_projection",
    horizonDays: 90,
  });
  const overviewRes = await runSkillForSession<OverviewView>(session, "relatorios_gerenciais", {
    action: "executive_overview",
  });

  const openAlerts = await repos.alerts.listOpen(companyId);
  const pendingApprovals = await repos.approvals.listByStatus(companyId, ["pending"]);

  const totals = cashRes.data?.totals;
  const daily = projRes.data?.daily ?? [];

  const in7Limit = addDays(today, 7);
  let payables7dCents = 0;
  let receivables7dCents = 0;
  for (const d of daily) {
    if (typeof d?.date === "string" && d.date <= in7Limit) {
      payables7dCents += d.outCents ?? 0;
      receivables7dCents += d.inCents ?? 0;
    }
  }

  // Agregação das próximas 4 semanas para o gráfico de barras.
  const weekGroups: InOutGroup[] = [];
  for (let w = 0; w < 4; w++) {
    const start = addDays(today, w * 7);
    const end = addDays(today, w * 7 + 6);
    let inCents = 0;
    let outCents = 0;
    for (const d of daily) {
      if (typeof d?.date === "string" && d.date >= start && d.date <= end) {
        inCents += d.inCents ?? 0;
        outCents += d.outCents ?? 0;
      }
    }
    weekGroups.push({
      label: `Sem ${w + 1}`,
      title: `${formatBR(start)} a ${formatBR(end)}`,
      inCents,
      outCents,
    });
  }

  const topAlerts = [...openAlerts]
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
        b.createdAt.localeCompare(a.createdAt)
    )
    .slice(0, 5);

  const available = totals?.availableCents;
  const availableTone =
    typeof available !== "number"
      ? "neutral"
      : available < 0
        ? "crit"
        : available < session.config.minimumCashCents
          ? "warn"
          : "ok";

  const risks = asStringList(overviewRes.data?.risks);
  const opportunities = asStringList(overviewRes.data?.opportunities);
  const recommendations = asStringList(overviewRes.data?.recommendations);

  return (
    <div>
      <PageHeader
        title="Dashboard executivo"
        subtitle={`Posição consolidada de ${session.company.name} em ${formatBR(today)}`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Saldo disponível"
          value={typeof available === "number" ? formatBRL(available) : "—"}
          tone={availableTone}
          hint={
            isSkillError(cashRes)
              ? "Skill de tesouraria em implementação"
              : "Soma dos saldos das contas bancárias ativas"
          }
        />
        <StatCard
          label="Comprometido"
          value={
            typeof totals?.committedCents === "number" ? formatBRL(totals.committedCents) : "—"
          }
          hint="Pagamentos agendados ou aguardando aprovação"
        />
        <StatCard
          label="A pagar (7 dias)"
          value={isSkillError(projRes) ? "—" : formatBRL(payables7dCents)}
          tone="warn"
          hint={`Saídas previstas até ${formatBR(in7Limit)}`}
        />
        <StatCard
          label="A receber (7 dias)"
          value={isSkillError(projRes) ? "—" : formatBRL(receivables7dCents)}
          tone="ok"
          hint={`Entradas previstas até ${formatBR(in7Limit)}`}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Entradas × saídas — próximas 4 semanas">
          {isSkillError(projRes) ? (
            <p className="text-sm text-[var(--ink-muted)]">Skill em implementação.</p>
          ) : (
            <>
              <InOutBarChart groups={weekGroups} />
              <SkillResultMeta result={projRes} showSources={false} />
            </>
          )}
        </Card>

        <Card title="Alertas abertos">
          {topAlerts.length === 0 ? (
            <EmptyState message="Nenhum alerta aberto. Tudo em ordem." />
          ) : (
            <ul className="space-y-2">
              {topAlerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-sm">
                  <Badge tone={SEVERITY_TONE[a.severity] ?? "neutral"}>
                    {SEVERITY_LABEL[a.severity] ?? a.severity}
                  </Badge>
                  <div className="min-w-0">
                    <p className="text-[var(--ink)]">{a.message}</p>
                    <p className="text-xs text-[var(--ink-muted)]">
                      {a.source} · {formatDateTime(a.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm">
            <Link href="/alertas" className="font-medium text-[var(--brand)] hover:underline">
              Ver todos os alertas →
            </Link>
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card title="Aprovações pendentes">
          {pendingApprovals.length === 0 ? (
            <EmptyState message="Nenhuma aprovação pendente." />
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {pendingApprovals.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <Badge tone="warn">Pendente</Badge>
                  <span className="min-w-0 flex-1 text-[var(--ink)]">{a.summary}</span>
                  {typeof a.amountCents === "number" ? (
                    <span className="tabular font-medium">{formatBRL(a.amountCents)}</span>
                  ) : null}
                  <span className="text-xs text-[var(--ink-muted)]">
                    Alçada: {ROLE_LABELS[a.requiredRole] ?? a.requiredRole}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm">
            <Link href="/aprovacoes" className="font-medium text-[var(--brand)] hover:underline">
              Ir para aprovações →
            </Link>
          </p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {isSkillError(overviewRes) ? (
          <SkillUnavailableCard title="Visão executiva" result={overviewRes} />
        ) : (
          <>
            <Card title="Riscos">
              {risks.length === 0 ? (
                <EmptyState message="Nenhum risco identificado." />
              ) : (
                <ul className="list-disc space-y-1 pl-4 text-sm text-[var(--ink)]">
                  {risks.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Oportunidades">
              {opportunities.length === 0 ? (
                <EmptyState message="Nenhuma oportunidade mapeada." />
              ) : (
                <ul className="list-disc space-y-1 pl-4 text-sm text-[var(--ink)]">
                  {opportunities.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Recomendações">
              {recommendations.length === 0 ? (
                <EmptyState message="Nenhuma recomendação no momento." />
              ) : (
                <ul className="list-disc space-y-1 pl-4 text-sm text-[var(--ink)]">
                  {recommendations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <SkillResultMeta result={overviewRes} />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
