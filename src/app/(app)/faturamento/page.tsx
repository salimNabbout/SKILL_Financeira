import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL, formatDateOrDash, statusLabel } from "@/lib/format";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createInvoiceAction } from "./actions";
import { MoneyInput } from "@/components/money-input";

export default async function FaturamentoPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const [invoices, customers] = await Promise.all([
    repos.invoices.listAll(companyId),
    repos.customers.listAll(companyId),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const rows = [...invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div>
      <PageHeader
        title="Faturamento"
        subtitle="Ciclo venda → fatura → títulos a receber. A emissão de NF-e/NFS-e é um mock identificado (nenhum documento fiscal real é emitido)."
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6" title="Faturas">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma fatura registrada ainda." />
        ) : (
          <Table
            headers={["Cliente", "Descrição", "Total", "Emissão", "Status", "NF-e (mock)"]}
            align={["l", "l", "r", "l", "l", "l"]}
          >
            {rows.map((inv) => (
              <tr key={inv.id}>
                <Td>{customerName.get(inv.customerId) ?? inv.customerId}</Td>
                <Td>{inv.description}</Td>
                <Td right>{formatBRL(inv.totalCents)}</Td>
                <Td>{formatDateOrDash(inv.issueDate)}</Td>
                <Td>
                  <Badge tone={statusTone(inv.status)}>{statusLabel(inv.status)}</Badge>
                </Td>
                <Td>
                  {inv.nfeMock ? (
                    <span className="tabular text-xs">{inv.nfeMock.number}</span>
                  ) : (
                    <span className="text-xs text-[var(--ink-muted)]">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Nova fatura">
        {customers.length === 0 ? (
          // Cliente é `required`: sem cadastro o select nasce vazio e o
          // navegador barra o submit sem dizer o motivo.
          <p className="text-sm text-[var(--ink-muted)]">
            Antes de emitir faturas, cadastre{" "}
            <Link href="/cadastros/clientes" className="text-[var(--brand)] underline">
              um cliente
            </Link>
            .
          </p>
        ) : (
        <form action={createInvoiceAction} className="grid gap-4 md:grid-cols-3">
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
            <input name="description" required className={inputClass} placeholder="Ex.: Pedido 1024 — assinatura anual" />
          </Field>
          <Field label="Total (R$)">
            <MoneyInput name="total" required className={inputClass} placeholder="2.500,00" />
          </Field>
          <Field label="Referência da venda (opcional)">
            <input name="saleRef" className={inputClass} placeholder="Ex.: PED-1024" />
          </Field>
          <div className="md:col-span-2">
            <Field label="Parcelas (opcional) — formato dd/mm/aaaa=valor;dd/mm/aaaa=valor">
              <input
                name="installments"
                className={inputClass}
                placeholder="15/09/2026=1.250,00; 15/10/2026=1.250,00"
              />
            </Field>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              A soma das parcelas deve ser igual ao total. Em branco: parcela única com vencimento em 30 dias.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="issue" defaultChecked className="h-4 w-4" />
            Emitir imediatamente (NF-e mock + títulos a receber)
          </label>
          <div className="flex items-end">
            <Button>Criar fatura</Button>
          </div>
        </form>
        )}
      </Card>
    </div>
  );
}
