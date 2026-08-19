import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";
import { todayInTz } from "@/core/dates";
import type { ReceivableStatus } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { createReceivableAction, issueChargeAction, registerReceiptAction } from "./actions";

const STATUS_FILTERS: Array<{ value: ReceivableStatus | "todos"; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "open", label: "Em aberto" },
  { value: "partially_received", label: "Recebidos parcial" },
  { value: "received", label: "Recebidos" },
  { value: "canceled", label: "Cancelados" },
];

const RECEIVABLE_OPEN: ReceivableStatus[] = ["open", "partially_received"];

export default async function ContasAReceberPage({
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
  const [page, customers, categories, bankAccounts] = await Promise.all([
    // Listagem paginada no repositório (volumetria) — ordem: vencimento asc.
    repos.receivables.listPage(companyId, {
      offset: pageOffset(p),
      limit: PAGE_SIZE,
      statuses: filter === "todos" ? undefined : [filter as ReceivableStatus],
    }),
    repos.customers.listAll(companyId),
    repos.categories.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const incomeCategories = categories.filter((c) => c.kind === "income" && c.active);
  const activeAccounts = bankAccounts.filter((b) => b.active);
  const rows = page.items;

  return (
    <div>
      <PageHeader
        title="Contas a receber"
        subtitle="Títulos de clientes, vencimentos, atrasos e registro de recebimentos."
      />
      <Flash ok={ok} erro={erro} />

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "todos" ? "/contas-a-receber" : `/contas-a-receber?status=${f.value}`}
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
            headers={["Cliente", "Descrição", "Parcela", "Vencimento", "Valor", "Recebido", "Status", "Registrar recebimento", "Cobrança (mock)"]}
            align={["l", "l", "l", "l", "r", "r", "l", "l", "l"]}
          >
            {rows.map((r) => {
              const overdue = r.dueDate < today && RECEIVABLE_OPEN.includes(r.status);
              const remaining = r.amountCents - r.receivedCents;
              return (
                <tr key={r.id}>
                  <Td>{customerName.get(r.customerId) ?? r.customerId}</Td>
                  <Td>{r.description}</Td>
                  <Td>{`${r.installmentNumber}/${r.installmentCount}`}</Td>
                  <Td>
                    <span className={overdue ? "font-semibold text-[var(--crit)]" : ""}>
                      {formatBR(r.dueDate)}
                      {overdue ? " (vencido)" : ""}
                    </span>
                  </Td>
                  <Td right>{formatBRL(r.amountCents)}</Td>
                  <Td right>{formatBRL(r.receivedCents)}</Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                  </Td>
                  <Td>
                    {RECEIVABLE_OPEN.includes(r.status) ? (
                      <form action={registerReceiptAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="receivableId" value={r.id} />
                        <input
                          name="amount"
                          required
                          inputMode="decimal"
                          defaultValue={(remaining / 100).toFixed(2).replace(".", ",")}
                          className={`${inputClass} w-24`}
                          title="Valor recebido (R$)"
                        />
                        <input
                          type="date"
                          name="receivedDate"
                          required
                          defaultValue={today}
                          className={`${inputClass} w-36`}
                        />
                        <select name="method" required className={`${inputClass} w-28`}>
                          <option value="pix">Pix</option>
                          <option value="boleto">Boleto</option>
                          <option value="card">Cartão</option>
                          <option value="transfer">Transferência</option>
                          <option value="cash">Dinheiro</option>
                        </select>
                        <select name="bankAccountId" className={`${inputClass} w-36`}>
                          <option value="">Sem conta</option>
                          {activeAccounts.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <Button variant="secondary">Registrar</Button>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                  <Td>
                    {RECEIVABLE_OPEN.includes(r.status) ? (
                      <form action={issueChargeAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="receivableId" value={r.id} />
                        <select name="kind" required className={`${inputClass} w-24`} title="Tipo de cobrança">
                          <option value="pix">Pix</option>
                          <option value="boleto">Boleto</option>
                        </select>
                        <Button variant="secondary">Gerar</Button>
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
          basePath="/contas-a-receber"
          extraQuery={{ status: filter === "todos" ? undefined : filter }}
        />
      </Card>

      <Card title="Novo título">
        <form action={createReceivableAction} className="grid gap-4 md:grid-cols-3">
          <Field label="Cliente">
            <select name="customerId" required className={inputClass}>
              <option value="">Selecione…</option>
              {customers
                .filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Descrição">
            <input name="description" required className={inputClass} placeholder="Ex.: Venda pedido 987" />
          </Field>
          <Field label="Valor total (R$)">
            <input name="amount" required className={inputClass} placeholder="1.234,56" inputMode="decimal" />
          </Field>
          <Field label="Emissão">
            <input type="date" name="issueDate" required defaultValue={today} className={inputClass} />
          </Field>
          <Field label="Vencimento">
            <input type="date" name="dueDate" required className={inputClass} />
          </Field>
          <Field label="Parcelas">
            <input type="number" name="installmentCount" min={1} max={120} defaultValue={1} className={inputClass} />
          </Field>
          <Field label="Categoria (opcional)">
            <select name="categoryId" className={inputClass}>
              <option value="">Sugerir automaticamente</option>
              {incomeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Método previsto (opcional)">
            <select name="method" className={inputClass}>
              <option value="">Não informado</option>
              <option value="pix">Pix</option>
              <option value="boleto">Boleto</option>
              <option value="card">Cartão</option>
              <option value="transfer">Transferência</option>
              <option value="cash">Dinheiro</option>
            </select>
          </Field>
          <div className="flex items-end">
            <Button>Criar título</Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          Criação e baixa são registradas com auditoria automática pela skill de contas a receber
          (idempotente: reenviar o mesmo formulário não duplica títulos).
        </p>
      </Card>
    </div>
  );
}
