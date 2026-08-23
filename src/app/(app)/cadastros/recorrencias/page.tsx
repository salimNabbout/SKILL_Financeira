import Link from "next/link";
import { Badge, Button, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { formatBR, formatBRL } from "@/lib/format";
import { todayInTz } from "@/core/dates";
import type { RecurringStatus } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { setRecurringStatusAction } from "./actions";
import { RecurringForm, type PartyOption } from "./_lib/recurring-form";

function statusLabel(s: RecurringStatus): string {
  if (s === "active") return "Ativa";
  if (s === "paused") return "Pausada";
  return "Encerrada";
}
function statusTone(s: RecurringStatus): "ok" | "neutral" | "warn" {
  if (s === "active") return "ok";
  if (s === "paused") return "warn";
  return "neutral";
}
export default async function RecorrenciasPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const today = todayInTz(clock.now(), session.config.timezone);

  const [templates, suppliers, customers, supplierCategories] = await Promise.all([
    repos.recurringTemplates.listAll(companyId),
    repos.suppliers.listAll(companyId),
    repos.customers.listAll(companyId),
    repos.supplierCategories.listAll(companyId),
  ]);

  const canManage = hasPermission(session.membership.role, "master_data.manage");
  // Nome da contraparte: fornecedor (payable) ou cliente (receivable).
  const partyName = new Map<string, string>([
    ...suppliers.map((s) => [s.id, s.name] as const),
    ...customers.map((c) => [c.id, c.name] as const),
  ]);
  const supplierOptions: PartyOption[] = suppliers
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name }));
  const customerOptions: PartyOption[] = customers
    .filter((c) => c.active)
    .map((c) => ({ id: c.id, name: c.name }));
  const categoryOptions = [...supplierCategories]
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const rows = [...templates].sort((a, b) =>
    a.description.localeCompare(b.description, "pt-BR")
  );

  return (
    <div>
      <PageHeader
        title="Recorrências"
        subtitle="Despesas e receitas mensais que geram títulos automaticamente (a pagar ou a receber). O título de cada mês é criado no início do mês, com vencimento no dia informado."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma recorrência cadastrada." />
        ) : (
          <Table
            headers={[
              "Descrição",
              "Tipo",
              "Contraparte",
              "Valor",
              "Vencimento",
              "Período",
              "Situação",
              ...(canManage ? [""] : []),
            ]}
            align={["l", "l", "l", "r", "l", "l", "l", ...(canManage ? ["l" as const] : [])]}
          >
            {rows.map((t) => (
              <tr key={t.id}>
                <Td>{t.description}</Td>
                <Td>{t.kind === "payable" ? "A pagar" : "A receber"}</Td>
                <Td>{partyName.get(t.counterpartyId) ?? t.counterpartyId}</Td>
                <Td right>{formatBRL(t.amountCents)}</Td>
                <Td>dia {t.dueDay}</Td>
                <Td>
                  {formatBR(t.startDate)}
                  {t.endDate ? ` até ${formatBR(t.endDate)}` : " (sem fim)"}
                </Td>
                <Td>
                  <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>
                </Td>
                {canManage ? (
                  <Td>
                    {t.status !== "ended" ? (
                      <div className="flex flex-wrap gap-1.5">
                        {t.status === "active" ? (
                          <form action={setRecurringStatusAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="status" value="paused" />
                            <Button variant="secondary">Pausar</Button>
                          </form>
                        ) : (
                          <form action={setRecurringStatusAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <input type="hidden" name="status" value="active" />
                            <Button variant="secondary">Retomar</Button>
                          </form>
                        )}
                        <form action={setRecurringStatusAction}>
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="status" value="ended" />
                          <button
                            type="submit"
                            className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
                          >
                            Encerrar
                          </button>
                        </form>
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Nova recorrência">
          <RecurringForm
            suppliers={supplierOptions}
            customers={customerOptions}
            categories={categoryOptions}
            today={today}
          />
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            O app gera o título de cada mês automaticamente (a pagar ou a receber). Pausar suspende a
            geração; encerrar a interrompe de vez. Títulos já gerados não são afetados.
          </p>
        </Card>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite gerenciar cadastros — visualização apenas.
        </p>
      )}
    </div>
  );
}
