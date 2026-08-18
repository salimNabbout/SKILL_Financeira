import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createSupplierAction } from "./actions";

export default async function FornecedoresPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const suppliers = await repos.suppliers.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...suppliers].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Fornecedores"
        subtitle="Base de contas a pagar. Dados bancários e chaves Pix são sempre mascarados."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum fornecedor cadastrado." />
        ) : (
          <Table headers={["Nome", "Documento", "E-mail", "Dados bancários", "Situação"]}>
            {rows.map((s) => (
              <tr key={s.id}>
                <Td>{s.name}</Td>
                <Td>{s.document ?? "—"}</Td>
                <Td>{s.email ?? "—"}</Td>
                <Td>
                  <span className="tabular text-xs">{s.bankInfoMasked ?? s.pixKeyMasked ?? "—"}</span>
                </Td>
                <Td>
                  <Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "Ativo" : "Inativo"}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Novo fornecedor">
          <form action={createSupplierAction} className="grid gap-4 md:grid-cols-4">
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
