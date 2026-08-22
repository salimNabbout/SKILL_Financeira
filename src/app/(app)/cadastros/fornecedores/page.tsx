import Link from "next/link";
import { Badge, Button, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { SupplierForm, type EditingSupplier, type KnownSupplier } from "./_lib/supplier-form";
import { importSuppliersAction } from "./actions";

function costLabel(c?: "fixed" | "variable"): string {
  if (c === "fixed") return "Custo Fixo";
  if (c === "variable") return "Custo Variável";
  return "—";
}

export default async function FornecedoresPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; editar?: string }>;
}) {
  const { ok, erro, editar } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const [suppliers, supplierCategories] = await Promise.all([
    repos.suppliers.listAll(session.company.id),
    repos.supplierCategories.listAll(session.company.id),
  ]);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...suppliers].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const categoryOptions = [...supplierCategories]
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const known: KnownSupplier[] = rows.map((s) => ({
    name: s.name,
    document: s.document,
    costClassification: s.costClassification,
    category: s.category,
  }));

  const editingSupplier = editar ? suppliers.find((s) => s.id === editar) : undefined;
  const editing: EditingSupplier | undefined = editingSupplier
    ? {
        id: editingSupplier.id,
        name: editingSupplier.name,
        document: editingSupplier.document,
        email: editingSupplier.email,
        phone: editingSupplier.phone,
        costClassification: editingSupplier.costClassification,
        category: editingSupplier.category,
      }
    : undefined;

  return (
    <div>
      <PageHeader
        title="Fornecedores"
        subtitle="Base de contas a pagar. Dados bancários e chaves Pix são sempre mascarados."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      {canManage ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <a
            href="/cadastros/fornecedores/export?format=csv"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
          >
            Exportar CSV
          </a>
          <a
            href="/cadastros/fornecedores/export?format=pdf"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
          >
            Imprimir PDF
          </a>
          <form action={importSuppliersAction} className="flex items-center gap-2">
            <input
              type="file"
              name="arquivo"
              accept=".csv,text/csv"
              required
              className="text-sm"
            />
            <Button>Importar CSV</Button>
          </form>
        </div>
      ) : null}

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum fornecedor cadastrado." />
        ) : (
          <Table
            headers={[
              "Fornecedor",
              "CNPJ/CPF",
              "E-mail",
              "Classificação do Custo",
              "Categoria",
              "Situação",
              ...(canManage ? [""] : []),
            ]}
          >
            {rows.map((s) => (
              <tr key={s.id}>
                <Td>{s.name}</Td>
                <Td>{s.document ?? "—"}</Td>
                <Td>{s.email ?? "—"}</Td>
                <Td>{costLabel(s.costClassification)}</Td>
                <Td>{s.category ?? "—"}</Td>
                <Td>
                  <Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "Ativo" : "Inativo"}</Badge>
                </Td>
                {canManage ? (
                  <Td>
                    <Link
                      href={`/cadastros/fornecedores?editar=${s.id}`}
                      className="text-sm text-[var(--brand)] underline"
                    >
                      Editar
                    </Link>
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title={editing ? `Editar fornecedor: ${editing.name}` : "Novo fornecedor"}>
          {editing ? (
            <p className="mb-3 text-sm">
              <Link href="/cadastros/fornecedores" className="text-[var(--brand)] underline">
                ← Cancelar edição (voltar a Novo fornecedor)
              </Link>
            </p>
          ) : null}
          {/* key força o React a remontar o form ao trocar de alvo (novo ⇄ editar,
              ou editar A → editar B); sem isso os useState iniciais não recarregam
              e as caixas ficam em branco ao clicar em "Editar". */}
          <SupplierForm
            key={editing?.id ?? "novo"}
            known={known}
            categories={categoryOptions}
            editing={editing}
          />
        </Card>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite gerenciar cadastros — visualização apenas.
        </p>
      )}
    </div>
  );
}
