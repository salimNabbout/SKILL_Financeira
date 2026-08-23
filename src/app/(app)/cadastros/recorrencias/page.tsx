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
import { RecurringForm, type SupplierOption } from "./_lib/recurring-form";

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
function costLabel(c?: "fixed" | "variable"): string {
  if (c === "fixed") return "Custo Fixo";
  if (c === "variable") return "Custo Variável";
  return "—";
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

  const [templates, suppliers, supplierCategories] = await Promise.all([
    repos.recurringTemplates.listAll(companyId),
    repos.suppliers.listAll(companyId),
    repos.supplierCategories.listAll(companyId),
  ]);

  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const supplierOptions: SupplierOption[] = suppliers
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name }));
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
        subtitle="Despesas mensais que geram títulos a pagar automaticamente. O título de cada mês é criado no início do mês, com vencimento no dia informado."
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
              "Fornecedor",
              "Valor",
              "Vencimento",
              "Período",
              "Custo",
              "Situação",
              ...(canManage ? [""] : []),
            ]}
            align={["l", "l", "r", "l", "l", "l", "l", ...(canManage ? ["l" as const] : [])]}
          >
            {rows.map((t) => (
              <tr key={t.id}>
                <Td>{t.description}</Td>
                <Td>{supplierName.get(t.counterpartyId) ?? t.counterpartyId}</Td>
                <Td right>{formatBRL(t.amountCents)}</Td>
                <Td>dia {t.dueDay}</Td>
                <Td>
                  {formatBR(t.startDate)}
                  {t.endDate ? ` até ${formatBR(t.endDate)}` : " (sem fim)"}
                </Td>
                <Td>{costLabel(t.costClassification)}</Td>
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
        <Card title="Nova recorrência (a pagar)">
          <RecurringForm suppliers={supplierOptions} categories={categoryOptions} today={today} />
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            O app gera o título a pagar de cada mês automaticamente. Pausar suspende a geração;
            encerrar a interrompe de vez. Títulos já gerados não são afetados.
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
