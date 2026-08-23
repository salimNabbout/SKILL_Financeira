import Link from "next/link";
import { Badge, Button, Card, EmptyState, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";
import { todayInTz } from "@/core/dates";
import type { PayableStatus } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { schedulePaymentAction } from "./actions";
import { NewPayableForm, type SupplierOption } from "./_lib/new-payable-form";

const STATUS_FILTERS: Array<{ value: PayableStatus | "todos"; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "open", label: "Em aberto" },
  { value: "scheduled", label: "Agendados" },
  { value: "partially_paid", label: "Pagos parcial" },
  { value: "paid", label: "Pagos" },
  { value: "canceled", label: "Cancelados" },
];

const SCHEDULABLE: PayableStatus[] = ["open", "partially_paid"];

export default async function ContasAPagarPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; p?: string; ok?: string; erro?: string }>;
}) {
  const { status, p, ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const today = todayInTz(clock.now(), session.config.timezone);

  const filter = STATUS_FILTERS.some((f) => f.value === status) ? status : "todos";
  const [page, suppliers, supplierCategories, bankAccounts] = await Promise.all([
    // Listagem paginada no repositório (volumetria) — ordem: vencimento asc.
    repos.payables.listPage(companyId, {
      offset: pageOffset(p),
      limit: PAGE_SIZE,
      statuses: filter === "todos" ? undefined : [filter as PayableStatus],
    }),
    repos.suppliers.listAll(companyId),
    repos.supplierCategories.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const activeAccounts = bankAccounts.filter((b) => b.active);
  const rows = page.items;

  // Opções do fornecedor levam a classificação de custo (espelho reativo no form).
  const supplierOptions: SupplierOption[] = suppliers
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, costClassification: s.costClassification }));
  const categoryOptions = [...supplierCategories]
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Contas a pagar"
        subtitle="Títulos de fornecedores, vencimentos e agendamento de pagamentos (sempre com aprovação humana)."
      />
      <Flash ok={ok} erro={erro} />

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "todos" ? "/contas-a-pagar" : `/contas-a-pagar?status=${f.value}`}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              filter === f.value
                ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                : "border-[var(--line)] bg-white text-[var(--ink)] hover:bg-slate-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum título encontrado para o filtro selecionado." />
        ) : (
          <Table
            headers={["Fornecedor", "Descrição", "Parcela", "Vencimento", "Valor", "Pago", "Status", "Conciliar", "Agendar pagamento"]}
            align={["l", "l", "l", "l", "r", "r", "l", "l", "l"]}
          >
            {rows.map((p) => {
              const overdue = p.dueDate < today && p.status !== "paid" && p.status !== "canceled";
              return (
                <tr key={p.id}>
                  <Td>{supplierName.get(p.supplierId) ?? p.supplierId}</Td>
                  <Td>{p.description}</Td>
                  <Td>{`${p.installmentNumber}/${p.installmentCount}`}</Td>
                  <Td>
                    <span className={overdue ? "font-semibold text-[var(--crit)]" : ""}>
                      {formatBR(p.dueDate)}
                    </span>
                  </Td>
                  <Td right>{formatBRL(p.amountCents)}</Td>
                  <Td right>{formatBRL(p.paidCents)}</Td>
                  <Td>
                    <Badge tone={statusTone(p.status)}>{statusLabel(p.status)}</Badge>
                  </Td>
                  <Td>
                    <Link
                      href={`/conciliacao?payable=${p.id}`}
                      className="text-sm text-[var(--brand)] underline"
                    >
                      Conciliar
                    </Link>
                  </Td>
                  <Td>
                    {SCHEDULABLE.includes(p.status) ? (
                      <form action={schedulePaymentAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="payableId" value={p.id} />
                        <select name="bankAccountId" required className={`${inputClass} w-36`}>
                          {activeAccounts.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="date"
                          name="scheduledDate"
                          required
                          defaultValue={p.dueDate >= today ? p.dueDate : today}
                          className={`${inputClass} w-36`}
                        />
                        <select name="method" required className={`${inputClass} w-24`}>
                          <option value="pix">Pix</option>
                          <option value="ted">TED</option>
                          <option value="boleto">Boleto</option>
                          <option value="debit">Débito</option>
                        </select>
                        <Button variant="secondary">Agendar</Button>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager
          page={page}
          basePath="/contas-a-pagar"
          extraQuery={{ status: filter === "todos" ? undefined : filter }}
        />
      </Card>

      <Card title="Novo título">
        <NewPayableForm suppliers={supplierOptions} categories={categoryOptions} today={today} />
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          O título passa pelo fluxo de entrada de nota (validação de duplicidade, projeção de caixa e
          impacto orçamentário). Valores em reais são convertidos para centavos.
        </p>
      </Card>
    </div>
  );
}
