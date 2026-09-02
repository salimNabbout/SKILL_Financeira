import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { ROLE_LABELS, formatBR, formatBRL, formatDateTime, statusLabel } from "@/lib/format";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { decideApprovalAction, reversePaymentAction } from "./actions";

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
  searchParams: Promise<{
    ok?: string;
    erro?: string;
    /** Pagamento cujo pop-up de confirmação de estorno está aberto. */
    estornar?: string;
    f_motivo?: string;
  }>;
}) {
  const sp = await searchParams;
  const { ok, erro } = sp;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const [pending, all, users, executedPayments] = await Promise.all([
    repos.approvals.listByStatus(companyId, ["pending"]),
    repos.approvals.listAll(companyId),
    repos.users.listAll(),
    // Só os EXECUTADOS: são os únicos estornáveis, e é por eles que o histórico
    // decide quais aprovações ainda podem voltar atrás.
    repos.payments.listByStatus(companyId, ["executed", "approved"]),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const pendingRows = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const history = all
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))
    .slice(0, 30);

  // Estorno: desfazer uma execução pesa como executá-la, então usa a mesma
  // permissão (payment.execute) — admin e gerente financeiro.
  const canReverse = hasPermission(session.membership.role, "payment.execute");
  const paymentById = new Map(executedPayments.map((pay) => [pay.id, pay]));
  const executedById = new Map(
    executedPayments.filter((pay) => pay.status === "executed").map((pay) => [pay.id, pay])
  );
  // Aprovado mas ainda não conciliado: a decisão fica no histórico (é trilha de
  // auditoria) e a AÇÃO pendente passa a viver na tela de Conciliação.
  const aguardandoConciliacao = (targetType: string, targetId: string): boolean =>
    targetType === "payment" && paymentById.get(targetId)?.status === "approved";
  // Estornável = aprovação de PAGAMENTO, aprovada, cujo pagamento ainda está
  // executado. Já estornado sai do mapa (vira "canceled") e o botão some.
  const isReversible = (targetType: string, status: string, targetId: string): boolean =>
    canReverse && targetType === "payment" && status === "approved" && executedById.has(targetId);

  // Pop-up de confirmação: só abre para um pagamento realmente estornável.
  const estornarId = sp.estornar?.trim() || undefined;
  const estornoPayment = estornarId ? executedById.get(estornarId) : undefined;
  const estornoPayable =
    canReverse && estornoPayment
      ? await repos.payables.getById(companyId, estornoPayment.payableId)
      : null;
  const estornoSupplier = estornoPayable
    ? await repos.suppliers.getById(companyId, estornoPayable.supplierId)
    : null;

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
            headers={[
              "Resumo",
              "Valor",
              "Solicitante",
              "Decisão",
              "Decidida por",
              "Quando",
              "Justificativa",
              "Estorno",
            ]}
            align={["l", "r", "l", "l", "l", "l", "l", "l"]}
          >
            {history.map((a) => (
              <tr key={a.id}>
                <Td>{a.summary}</Td>
                <Td right>{a.amountCents !== undefined ? formatBRL(a.amountCents) : "—"}</Td>
                <Td>{userName.get(a.requestedBy) ?? a.requestedBy}</Td>
                <Td>
                  <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
                  {/* Aprovar não paga: quem baixa o título é a conciliação. */}
                  {aguardandoConciliacao(a.targetType, a.targetId) ? (
                    <Link
                      href="/conciliacao"
                      className="mt-1 block text-xs text-[var(--brand)] underline"
                    >
                      Aguardando conciliação
                    </Link>
                  ) : null}
                </Td>
                <Td>{a.decidedBy ? (userName.get(a.decidedBy) ?? a.decidedBy) : "—"}</Td>
                <Td>{a.decidedAt ? formatDateTime(a.decidedAt) : "—"}</Td>
                <Td>{a.justification ?? "—"}</Td>
                {/* Estorno: só para pagamento aprovado e ainda executado. O
                    botão não estorna — abre o pop-up de confirmação (?estornar). */}
                <Td className="whitespace-nowrap">
                  {isReversible(a.targetType, a.status, a.targetId) ? (
                    <form method="get" action="/aprovacoes" className="inline">
                      <input type="hidden" name="estornar" value={a.targetId} />
                      <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                        <Button variant="danger" type="submit">
                          Estornar
                        </Button>
                      </span>
                    </form>
                  ) : (
                    <span className="text-xs text-[var(--ink-muted)]">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* POP-UP de confirmação do estorno. Sobreposição renderizada no servidor
          (sem estado de cliente): abre por ?estornar=<paymentId> e fecha
          voltando para /aprovacoes. Confirmar exige o motivo, que vai para a
          trilha de auditoria. */}
      {estornoPayment && estornoPayable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-lg p-4 shadow-xl">
            <h2 className="text-base font-semibold text-[var(--crit)]">Confirmar estorno</h2>
            <p className="mt-2 text-sm">
              O pagamento de{" "}
              <strong className="tabular">{formatBRL(estornoPayment.amountCents)}</strong>
              {estornoSupplier ? ` a ${estornoSupplier.name}` : ""} será estornado.
            </p>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              {estornoPayable.description} · vencimento {formatBR(estornoPayable.dueDate)}
            </p>
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              A baixa será desfeita e o título <strong>volta para Contas a pagar</strong>. O
              pagamento não é apagado: fica como cancelado e o estorno é registrado na
              auditoria com o motivo informado.
            </p>
            <form action={reversePaymentAction} className="mt-3">
              <input type="hidden" name="paymentId" value={estornoPayment.id} />
              <Field label="Motivo do estorno">
                <input
                  name="reason"
                  required
                  autoFocus
                  defaultValue={sp.f_motivo ?? ""}
                  className={inputClass}
                  placeholder="Ex.: pagamento em duplicidade"
                />
              </Field>
              <div className="mt-3 flex items-center gap-2">
                <Button variant="danger" type="submit">
                  Confirmar estorno
                </Button>
                <Link
                  href="/aprovacoes"
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                >
                  Voltar
                </Link>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
