import Link from "next/link";
import { Badge, Button, Card, EmptyState, PageHeader, Table, Td, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatDateTime, statusLabel } from "@/lib/format";
import type { Alert } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { acknowledgeAlertAction } from "./actions";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** Rota da entidade relacionada, quando faz sentido navegar até ela. */
function entityHref(entityType?: string): string | null {
  switch (entityType) {
    case "payable":
    case "payment":
      return "/contas-a-pagar";
    case "receivable":
    case "receipt":
      return "/contas-a-receber";
    case "invoice":
      return "/faturamento";
    case "reconciliation_match":
    case "bank_transaction":
    case "import_batch":
      return "/conciliacao";
    case "collection_message":
      return "/cobranca";
    case "Approval":
    case "approval":
      return "/aprovacoes";
    default:
      return null;
  }
}

function severityBadge(a: Alert) {
  return <Badge tone={statusTone(a.severity)}>{statusLabel(a.severity)}</Badge>;
}

export default async function AlertasPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const all = await repos.alerts.listAll(companyId);
  const open = all
    .filter((a) => a.status === "open")
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
        b.createdAt.localeCompare(a.createdAt)
    );
  const handled = all
    .filter((a) => a.status !== "open")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 25);

  return (
    <div>
      <PageHeader
        title="Alertas e pendências"
        subtitle="Central de pendências geradas pelas skills e pelo orquestrador — críticos primeiro."
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6" title={`Abertos (${open.length})`}>
        {open.length === 0 ? (
          <EmptyState message="Nenhum alerta aberto — tudo em dia." />
        ) : (
          <Table
            headers={["Severidade", "Mensagem", "Fonte", "Entidade", "Quando", "Ação"]}
            align={["l", "l", "l", "l", "l", "l"]}
          >
            {open.map((a) => {
              const href = entityHref(a.entityType);
              return (
                <tr key={a.id}>
                  <Td>{severityBadge(a)}</Td>
                  <Td>
                    <span className="text-sm">{a.message}</span>
                    <span className="ml-2 text-xs text-[var(--ink-muted)]">({a.code})</span>
                  </Td>
                  <Td>
                    <span className="text-xs">{a.source}</span>
                  </Td>
                  <Td>
                    {a.entityType ? (
                      href ? (
                        <Link href={href} className="text-xs text-[var(--brand)] underline">
                          {a.entityType} {a.entityId ?? ""}
                        </Link>
                      ) : (
                        <span className="text-xs text-[var(--ink-muted)]">
                          {a.entityType} {a.entityId ?? ""}
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                  <Td>{formatDateTime(a.createdAt)}</Td>
                  <Td>
                    <form action={acknowledgeAlertAction}>
                      <input type="hidden" name="alertId" value={a.id} />
                      <Button variant="secondary">Reconhecer</Button>
                    </form>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Reconhecidos e resolvidos recentes">
        {handled.length === 0 ? (
          <EmptyState message="Nenhum alerta tratado ainda." />
        ) : (
          <Table
            headers={["Severidade", "Mensagem", "Fonte", "Status", "Criado em"]}
            align={["l", "l", "l", "l", "l"]}
          >
            {handled.map((a) => (
              <tr key={a.id}>
                <Td>{severityBadge(a)}</Td>
                <Td>{a.message}</Td>
                <Td>
                  <span className="text-xs">{a.source}</span>
                </Td>
                <Td>
                  <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
                </Td>
                <Td>{formatDateTime(a.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
