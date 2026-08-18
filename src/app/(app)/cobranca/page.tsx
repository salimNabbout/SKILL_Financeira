import Link from "next/link";
import { Badge, Button, Card, EmptyState, PageHeader, StatCard, Table, Td, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL, formatDateTime, statusLabel } from "@/lib/format";
import type {
  DelinquencyIndicatorsData,
  SegmentCustomersData,
} from "@/skills/cobranca";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { callSkill } from "@/app/(app)/contas-a-receber/_lib/call-skill";
import { runDunningAction } from "./actions";

const CHANNEL_LABELS: Record<string, string> = {
  email: "E-mail",
  whatsapp_mock: "WhatsApp (mock)",
  letter: "Carta",
};

const RISK_LABELS: Record<string, string> = {
  baixo: "Baixo",
  medio: "Médio",
  alto: "Alto",
};

const RISK_TONE: Record<string, "ok" | "warn" | "crit"> = {
  baixo: "ok",
  medio: "warn",
  alto: "crit",
};

export default async function CobrancaPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const [messages, customers, receivables] = await Promise.all([
    repos.collectionMessages.listAll(companyId),
    repos.customers.listAll(companyId),
    repos.receivables.listAll(companyId),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const receivableById = new Map(receivables.map((r) => [r.id, r]));
  const rows = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Leituras via skill (determinísticas): indicadores e segmentação.
  const indicatorsResult = await callSkill<DelinquencyIndicatorsData>(session, "cobranca_inadimplencia", {
    action: "delinquency_indicators",
  });
  const segmentsResult = await callSkill<SegmentCustomersData>(session, "cobranca_inadimplencia", {
    action: "segment_customers",
  });
  const indicators = indicatorsResult.data?.indicators;
  const segments = segmentsResult.data?.segments ?? [];

  return (
    <div>
      <PageHeader
        title="Cobrança e inadimplência"
        subtitle="Régua de cobrança com aprovação humana obrigatória. O envio de mensagens é MOCK: nenhum e-mail ou WhatsApp real é disparado."
        actions={
          <form action={runDunningAction}>
            <Button>Rodar régua de cobrança</Button>
          </form>
        }
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6" title="Indicadores de inadimplência">
        {!indicators ? (
          <EmptyState message="Indicadores indisponíveis no momento." />
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <StatCard
                label="Taxa de inadimplência"
                value={
                  indicators.delinquencyRatePercent?.value === null ||
                  indicators.delinquencyRatePercent?.value === undefined
                    ? "—"
                    : `${indicators.delinquencyRatePercent.value.toFixed(1)}%`
                }
                hint={indicators.delinquencyRatePercent?.formula}
                tone={(indicators.delinquencyRatePercent?.value ?? 0) > 10 ? "crit" : "neutral"}
              />
              <StatCard
                label="Ticket médio vencido"
                value={
                  indicators.averageOverdueTicketCents?.value === null ||
                  indicators.averageOverdueTicketCents?.value === undefined
                    ? "—"
                    : formatBRL(indicators.averageOverdueTicketCents.value)
                }
                hint={indicators.averageOverdueTicketCents?.formula}
              />
              <StatCard
                label="Clientes inadimplentes"
                value={String(indicators.delinquentCustomerCount?.value ?? "—")}
                hint={indicators.delinquentCustomerCount?.formula}
              />
              <StatCard
                label="DSO (dias)"
                value={
                  indicators.dsoDays?.value === null || indicators.dsoDays?.value === undefined
                    ? "—"
                    : String(indicators.dsoDays.value)
                }
                hint={indicators.dsoDays?.formula}
              />
            </div>
            {indicators.agingCents ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                  Aging da carteira vencida — {indicators.agingCents.formula}
                </p>
                <div className="grid gap-4 md:grid-cols-4">
                  {Object.entries(indicators.agingCents.value ?? {}).map(([bucket, cents]) => (
                    <StatCard key={bucket} label={`${bucket} dias`} value={formatBRL(cents)} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Card className="mb-6" title="Segmentação de clientes em atraso">
        {segments.length === 0 ? (
          <EmptyState message="Nenhum cliente com títulos vencidos — carteira em dia." />
        ) : (
          <>
            <Table
              headers={["Cliente", "Bucket (dias)", "Risco", "Títulos vencidos", "Total vencido", "Maior atraso"]}
              align={["l", "l", "l", "r", "r", "r"]}
            >
              {segments.map((s) => (
                <tr key={s.customerId}>
                  <Td>{s.customerName}</Td>
                  <Td>{s.bucket}</Td>
                  <Td>
                    <Badge tone={RISK_TONE[s.risk] ?? "neutral"}>{RISK_LABELS[s.risk] ?? s.risk}</Badge>
                  </Td>
                  <Td right>{s.overdueCount}</Td>
                  <Td right>{formatBRL(s.overdueCents)}</Td>
                  <Td right>{s.maxDaysLate} dia(s)</Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              {segmentsResult.data?.formula}
            </p>
          </>
        )}
      </Card>

      <Card title={`Mensagens de cobrança (${rows.length})`}>
        <p className="mb-3 text-xs text-[var(--ink-muted)]">
          Mensagens aguardando aprovação são decididas em{" "}
          <Link href="/aprovacoes" className="text-[var(--brand)] underline">
            Aprovações
          </Link>
          . Mesmo aprovadas, o envio é <strong>mock</strong> no MVP.
        </p>
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma mensagem de cobrança gerada ainda. Rode a régua para gerar rascunhos." />
        ) : (
          <Table
            headers={["Cliente", "Título", "Etapa", "Canal", "Status", "Enviada em", "Mensagem"]}
            align={["l", "l", "l", "l", "l", "l", "l"]}
          >
            {rows.map((m) => {
              const receivable = receivableById.get(m.receivableId);
              return (
                <tr key={m.id}>
                  <Td>{customerName.get(m.customerId) ?? m.customerId}</Td>
                  <Td>
                    <span title={m.receivableId}>{receivable?.description ?? m.receivableId}</span>
                  </Td>
                  <Td>{m.step} dia(s)</Td>
                  <Td>{CHANNEL_LABELS[m.channel] ?? m.channel}</Td>
                  <Td>
                    <Badge tone={statusTone(m.status)}>{statusLabel(m.status)}</Badge>
                  </Td>
                  <Td>{m.sentAt ? formatDateTime(m.sentAt) : "—"}</Td>
                  <Td>
                    <details>
                      <summary className="cursor-pointer text-xs text-[var(--brand)]">
                        {m.subject}
                      </summary>
                      <p className="mt-1 max-w-md whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">
                        {m.body}
                      </p>
                    </details>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
