import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createCustomerAction } from "./actions";

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const customers = await repos.customers.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...customers].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Clientes"
        subtitle="Base de contas a receber, faturamento e cobrança."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum cliente cadastrado." />
        ) : (
          <Table headers={["Nome", "Documento", "E-mail", "Telefone", "Situação"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>{c.name}</Td>
                <Td>{c.document ?? "—"}</Td>
                <Td>{c.email ?? "—"}</Td>
                <Td>{c.phone ?? "—"}</Td>
                <Td>
                  <Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "Ativo" : "Inativo"}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Novo cliente">
          <form action={createCustomerAction} className="grid gap-4 md:grid-cols-4">
            <Field label="Nome">
              <input name="name" required className={inputClass} />
            </Field>
            <Field label="CNPJ/CPF (opcional)">
              <input name="document" className={inputClass} />
            </Field>
            <Field label="E-mail (opcional)">
              <input name="email" type="email" className={inputClass} />
            </Field>
            <Field label="Telefone (opcional)">
              <input name="phone" className={inputClass} />
            </Field>
            <div className="flex items-end">
              <Button>Cadastrar</Button>
            </div>
          </form>
        </Card>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite gerenciar cadastros — visualização apenas.
        </p>
      )}
    </div>
  );
}
