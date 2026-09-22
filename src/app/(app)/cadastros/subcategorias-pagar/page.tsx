import { Fragment } from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import {
  createPayableSubcategoryAction,
  deletePayableSubcategoryAction,
  reactivatePayableSubcategoryAction,
  updatePayableSubcategoryAction,
} from "./actions";
import { countPayableSubcategoryLinks, type PayableSubcategoryLinks } from "./_lib/delete";

const PATH = "/cadastros/subcategorias-pagar";

/**
 * Cadastro "Subcategoria a PAGAR": a lista que alimenta a caixa SUBCATEGORIA do
 * formulário "Novo título" em Contas a pagar. Mesmo desenho da tela de
 * Categoria a PAGAR: edição inline por ?editar=, exclusão confirmada por
 * ?excluir=, tudo Server Component sem estado no cliente.
 */
export default async function SubcategoriasPagarPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; editar?: string; excluir?: string }>;
}) {
  const { ok, erro, editar, excluir } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const subcategories = await repos.payableSubcategories.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...subcategories].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  // Vínculos da subcategoria em confirmação de exclusão (só quando ?excluir=
  // aponta para uma linha): decide entre apagar e desativar, e informa o usuário.
  const excluindo = excluir ? rows.find((s) => s.id === excluir) : undefined;
  const excluirLinks: PayableSubcategoryLinks | null = excluindo
    ? await countPayableSubcategoryLinks({ repos }, session.company.id, excluindo.name)
    : null;

  return (
    <div>
      <PageHeader
        title="Subcategoria A PAGAR"
        subtitle="Lista de subcategorias que alimenta a caixa SUBCATEGORIA do novo título em Contas a pagar."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma subcategoria cadastrada." />
        ) : (
          <Table headers={canManage ? ["Subcategoria", "Situação", "Ações"] : ["Subcategoria", "Situação"]}>
            {rows.map((s) => {
              const editing = editar === s.id;
              const excluding = excluir === s.id;
              return (
                <Fragment key={s.id}>
                  <tr>
                    <Td>
                      {canManage && editing ? (
                        <form action={updatePayableSubcategoryAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="id" value={s.id} />
                          <input
                            name="name"
                            required
                            defaultValue={s.name}
                            className={`${inputClass} w-56`}
                            aria-label={`Novo nome da subcategoria ${s.name}`}
                          />
                          <Button>Salvar</Button>
                          <Link href={PATH} className="text-xs text-[var(--ink-muted)] underline">
                            Cancelar
                          </Link>
                        </form>
                      ) : (
                        s.name
                      )}
                    </Td>
                    <Td>
                      <Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "Ativa" : "Inativa"}</Badge>
                    </Td>
                    {canManage ? (
                      <Td className="whitespace-nowrap">
                        <div className="flex flex-nowrap items-center gap-1">
                          {editing ? null : (
                            <form method="get" action={PATH} className="inline">
                              <input type="hidden" name="editar" value={s.id} />
                              <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                <Button variant="warn" type="submit">
                                  ✎ Editar
                                </Button>
                              </span>
                            </form>
                          )}
                          {s.active ? (
                            <form method="get" action={PATH} className="inline">
                              <input type="hidden" name="excluir" value={excluding ? "" : s.id} />
                              <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                <Button variant="danger" type="submit">
                                  {excluding ? "Fechar" : "🗑 Excluir"}
                                </Button>
                              </span>
                            </form>
                          ) : (
                            <form action={reactivatePayableSubcategoryAction} className="inline">
                              <input type="hidden" name="id" value={s.id} />
                              <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                <Button variant="warn" type="submit">
                                  Reativar
                                </Button>
                              </span>
                            </form>
                          )}
                        </div>
                      </Td>
                    ) : null}
                  </tr>

                  {excluding && canManage && excluirLinks ? (
                    <tr>
                      {/* <td> cru para colSpan — o Td compartilhado não o expõe. */}
                      <td className="px-3 py-3 align-top" colSpan={3}>
                        <form action={deletePayableSubcategoryAction} className="rounded-lg border border-red-200 bg-red-50 p-3">
                          <input type="hidden" name="id" value={s.id} />
                          {excluirLinks.total === 0 ? (
                            <p className="mb-3 text-sm text-[var(--crit)]">
                              Nenhum título a pagar usa a subcategoria &quot;{s.name}&quot;. Ela será excluída
                              definitivamente.
                            </p>
                          ) : (
                            <p className="mb-3 text-sm text-[var(--crit)]">
                              A subcategoria &quot;{s.name}&quot; está em uso por {excluirLinks.payables} título(s) a
                              pagar. Ela será desativada e deixará de aparecer em novos lançamentos, mas os títulos
                              existentes permanecem inalterados.
                            </p>
                          )}
                          <div className="flex items-center gap-2">
                            <Button variant="danger" type="submit">
                              {excluirLinks.total === 0 ? "Confirmar exclusão" : "Confirmar desativação"}
                            </Button>
                            <Link
                              href={PATH}
                              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
                            >
                              Voltar
                            </Link>
                          </div>
                        </form>
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
        <Card title="Nova subcategoria">
          <form action={createPayableSubcategoryAction} className="grid gap-4 md:grid-cols-4">
            <Field label="Subcategoria">
              <input name="name" required className={inputClass} placeholder="Ex.: Energia elétrica" />
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
