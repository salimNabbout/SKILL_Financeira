import { Badge, Button, Card, EmptyState, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { ROLE_LABELS, formatBRL, formatDateTime, statusLabel } from "@/lib/format";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { decideApprovalAction } from "./actions";

const TARGET_LABELS: Record<string, string> = {
  payment: "Pagamento",
  collection_message: "Mensagem de cobrança",
  bank_change: "Alteração bancária",
  deletion: "Exclusão",
  flow_step: "Passo de fluxo",
};

export default async function AprovacoesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const [pending, all, users] = await Promise.all([
    repos.approvals.listByStatus(companyId, ["pending"]),
    repos.approvals.listAll(companyId),
    repos.users.listAll(),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const pendingRows = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const history = all
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))
    .slice(0, 30);

  return (
    <div>
      <PageHeader
        title="Aprovações"
        subtitle="Decisões humanas obrigatórias para ações sensíveis. Segregação de funções: quem solicita não aprova a própria solicitação."
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6" title={`Pendentes (${pendingRows.length})`}>
        {pendingRows.length === 0 ? (
          <EmptyState message="Nenhuma aprovação pendente." />
        ) : (
          <div className="space-y-3">
            {pendingRows.map((a) => (
              <div key={a.id} className="rounded-lg border border-[var(--line)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      <Badge tone="brand">{TARGET_LABELS[a.targetType] ?? a.targetType}</Badge>{" "}
                      {a.summary}
                    </p>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      Valor:{" "}
                      <strong className="tabular">
                        {a.amountCents !== undefined ? formatBRL(a.amountCents) : "—"}
                      </strong>{" "}
                      · Solicitante: {userName.get(a.requestedBy) ?? a.requestedBy} · Papel mínimo:{" "}
                      {ROLE_LABELS[a.requiredRole] ?? a.requiredRole} · Criada em{" "}
                      {formatDateTime(a.createdAt)}
                    </p>
                    {(a.approvalsRequired ?? 1) > 1 ? (
                      <p className="mt-1 text-xs font-medium text-amber-700">
                        Dupla aprovação: {(a.approverIds ?? []).length}/{a.approvalsRequired}{" "}
                        aprovação(ões) registrada(s)
                        {(a.approverIds ?? []).length > 0
                          ? ` — já aprovou: ${(a.approverIds ?? [])
                              .map((id) => userName.get(id) ?? id)
                              .join(", ")}`
                          : ""}
                        . Cada aprovação deve vir de uma pessoa diferente.
                      </p>
                    ) : null}
                  </div>
                  <form action={decideApprovalAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="approvalId" value={a.id} />
                    <input
                      name="justification"
                      className={`${inputClass} w-56`}
                      placeholder="Justificativa (opcional)"
                    />
                    <Button name="decision" value="approved">
                      Aprovar
                    </Button>
                    <Button name="decision" value="rejected" variant="danger">
                      Rejeitar
                    </Button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Histórico de decisões">
        {history.length === 0 ? (
          <EmptyState message="Nenhuma decisão registrada ainda." />
        ) : (
          <Table
            headers={["Resumo", "Valor", "Solicitante", "Decisão", "Decidida por", "Quando", "Justificativa"]}
            align={["l", "r", "l", "l", "l", "l", "l"]}
          >
            {history.map((a) => (
              <tr key={a.id}>
                <Td>{a.summary}</Td>
                <Td right>{a.amountCents !== undefined ? formatBRL(a.amountCents) : "—"}</Td>
                <Td>{userName.get(a.requestedBy) ?? a.requestedBy}</Td>
                <Td>
                  <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
                </Td>
                <Td>{a.decidedBy ? (userName.get(a.decidedBy) ?? a.decidedBy) : "—"}</Td>
                <Td>{a.decidedAt ? formatDateTime(a.decidedAt) : "—"}</Td>
                <Td>{a.justification ?? "—"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
