import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createSupplierCategoryAction, updateSupplierCategoryAction } from "./actions";

const PATH = "/cadastros/categorias-fornecedores";

export default async function CategoriasFornecedoresPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; editar?: string }>;
}) {
  const { ok, erro, editar } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const categories = await repos.supplierCategories.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...categories].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Categoria de Fornecedores"
        subtitle="Lista de categorias que alimentam o campo CATEGORIA no cadastro de fornecedores."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma categoria de fornecedor cadastrada." />
        ) : (
          <Table headers={canManage ? ["Categoria", "Situação", "Ações"] : ["Categoria", "Situação"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>
                  {canManage && editar === c.id ? (
                    // Edição inline sem estado no cliente: o id em ?editar= diz
                    // qual linha abre, e a página segue Server Component.
                    <form action={updateSupplierCategoryAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="id" value={c.id} />
                      <input
                        name="name"
                        required
                        defaultValue={c.name}
                        className={`${inputClass} w-56`}
                        aria-label={`Novo nome da categoria ${c.name}`}
                      />
                      <Button>Salvar</Button>
                      <Link
                        href={PATH}
                        className="text-xs text-[var(--ink-muted)] underline"
                      >
                        Cancelar
                      </Link>
                    </form>
                  ) : (
                    c.name
                  )}
                </Td>
                <Td>
                  <Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "Ativa" : "Inativa"}</Badge>
                </Td>
                {canManage ? (
                  <Td>
                    {editar === c.id ? null : (
                      <form method="get" action={PATH}>
                        <input type="hidden" name="editar" value={c.id} />
                        <Button variant="warn">Editar</Button>
                      </form>
                    )}
                  </Td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Nova categoria">
          <form action={createSupplierCategoryAction} className="grid gap-4 md:grid-cols-4">
            <Field label="Categoria">
              <input name="name" required className={inputClass} />
            </Field>
            <div className="flex items-end">
              <Button>Adicionar</Button>
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
