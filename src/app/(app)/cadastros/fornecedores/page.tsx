import { Fragment } from "react";
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
            {/* Label estilizado como os demais botões: esconde o input nativo
                (que mostraria "Nenhum arquivo escolhido") e exibe só "Escolher arquivo". */}
            <label className="cursor-pointer rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--muted)]">
              Escolher arquivo
              <input
                type="file"
                name="arquivo"
                accept=".csv,text/csv"
                required
                className="sr-only"
              />
            </label>
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
            {rows.map((s) => {
              const editingThis = editing?.id === s.id;
              return (
                <Fragment key={s.id}>
                  <tr>
                    <Td>{s.name}</Td>
                    <Td>{s.document ?? "—"}</Td>
                    <Td>{s.email ?? "—"}</Td>
                    <Td>{costLabel(s.costClassification)}</Td>
                    <Td>{s.category ?? "—"}</Td>
                    <Td>
                      <Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "Ativo" : "Inativo"}</Badge>
                    </Td>
                    {canManage ? (
                      <Td className="whitespace-nowrap">
                        {/* Mesmo padrão de /contas-a-pagar: botão laranja compacto que
                            abre/fecha o form inline via GET (?editar=<id>), sem client/useState
                            na página. Alterna para "Fechar" na linha em edição. */}
                        <form method="get" action="/cadastros/fornecedores" className="inline">
                          <input
                            type="hidden"
                            name="editar"
                            value={editingThis ? "" : s.id}
                          />
                          <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                            <Button variant="warn" type="submit">
                              {editingThis ? "Fechar" : "✎ Editar"}
                            </Button>
                          </span>
                        </form>
                      </Td>
                    ) : null}
                  </tr>
                  {editingThis && editing ? (
                    <tr>
                      {/* Form de edição inline na própria linha (padrão de /contas-a-pagar).
                          <td> cru para permitir colSpan — o Td compartilhado não o expõe e
                          não pode ser alterado. Reaproveita SupplierForm em modo edição
                          (defaultValues + updateSupplierAction), sem reescrevê-lo. */}
                      <td className="px-3 py-3 align-top" colSpan={7}>
                        <div className="rounded-lg border border-[var(--line)] bg-slate-50 p-3">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">Editar: {editing.name}</span>
                            <Link
                              href="/cadastros/fornecedores"
                              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
                            >
                              Cancelar
                            </Link>
                          </div>
                          <SupplierForm
                            key={editing.id}
                            known={known}
                            categories={categoryOptions}
                            editing={editing}
                          />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </Table>
        )}
      </Card>

      {canManage ? (
        // A edição agora acontece inline na linha (?editar=<id>); este Card é
        // sempre o cadastro de NOVO fornecedor.
        <Card title="Novo fornecedor">
          <SupplierForm known={known} categories={categoryOptions} />
        </Card>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite gerenciar cadastros — visualização apenas.
        </p>
      )}
    </div>
  );
}
