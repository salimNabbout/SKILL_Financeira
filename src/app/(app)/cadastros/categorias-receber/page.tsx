import { Fragment } from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import {
  createReceivableCategoryAction,
  deleteReceivableCategoryAction,
  reactivateReceivableCategoryAction,
  updateReceivableCategoryAction,
} from "./actions";
import { listReceivableCategories } from "./_lib/create";
import { countReceivableCategoryLinks, type ReceivableCategoryLinks } from "./_lib/delete";

const PATH = "/cadastros/categorias-receber";

/**
 * "Categoria a RECEBER": as categorias de receita que alimentam o campo
 * "Categoria (opcional)" de Contas a receber. Mesmo padrão da tela
 * "Categoria a PAGAR": tabela Categoria / Situação / Ações (Editar, Excluir),
 * edição e confirmação inline via ?editar= / ?excluir= (Server Component).
 */
export default async function CategoriasReceberPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; editar?: string; excluir?: string }>;
}) {
  const { ok, erro, editar, excluir } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const categories = await listReceivableCategories({ repos }, session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...categories].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const excluindo = excluir ? rows.find((c) => c.id === excluir) : undefined;
  const excluirLinks: ReceivableCategoryLinks | null = excluindo
    ? await countReceivableCategoryLinks({ repos }, session.company.id, excluindo.id)
    : null;

  return (
    <div>
      <PageHeader
        title="Categoria a RECEBER"
        subtitle="Lista de categorias que alimenta o campo CATEGORIA (opcional) em Contas a receber."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma categoria a receber cadastrada." />
        ) : (
          <Table headers={canManage ? ["Categoria", "Situação", "Ações"] : ["Categoria", "Situação"]}>
            {rows.map((c) => {
              const editing = editar === c.id;
              const excluding = excluir === c.id;
              return (
                <Fragment key={c.id}>
                  <tr>
                    <Td>
                      {canManage && editing ? (
                        <form action={updateReceivableCategoryAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="id" value={c.id} />
                          <input
                            name="name"
                            required
                            defaultValue={c.name}
                            className={`${inputClass} w-56`}
                            aria-label={`Novo nome da categoria ${c.name}`}
                          />
                          <Button>Salvar</Button>
                          <Link href={PATH} className="text-xs text-[var(--ink-muted)] underline">
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
                      <Td className="whitespace-nowrap">
                        <div className="flex flex-nowrap items-center gap-1">
                          {editing ? null : (
                            <form method="get" action={PATH} className="inline">
                              <input type="hidden" name="editar" value={c.id} />
                              <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                <Button variant="warn" type="submit">
                                  ✎ Editar
                                </Button>
                              </span>
                            </form>
                          )}
                          {c.active ? (
                            <form method="get" action={PATH} className="inline">
                              <input type="hidden" name="excluir" value={excluding ? "" : c.id} />
                              <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                <Button variant="danger" type="submit">
                                  {excluding ? "Fechar" : "🗑 Excluir"}
                                </Button>
                              </span>
                            </form>
                          ) : (
                            <form action={reactivateReceivableCategoryAction} className="inline">
                              <input type="hidden" name="id" value={c.id} />
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
                        <form
                          action={deleteReceivableCategoryAction}
                          className="rounded-lg border border-red-200 bg-red-50 p-3"
                        >
                          <input type="hidden" name="id" value={c.id} />
                          {excluirLinks.total === 0 ? (
                            <p className="mb-3 text-sm text-[var(--crit)]">
                              Nenhum título ou linha de orçamento usa a categoria &quot;{c.name}&quot;. Ela
                              será excluída definitivamente.
                            </p>
                          ) : (
                            <p className="mb-3 text-sm text-[var(--crit)]">
                              A categoria &quot;{c.name}&quot; está em uso por {excluirLinks.receivables}{" "}
                              título(s) a receber, {excluirLinks.payables} título(s) a pagar e{" "}
                              {excluirLinks.budgetLines} linha(s) de orçamento. Ela será desativada e
                              deixará de aparecer em novos lançamentos, mas os registros existentes
                              permanecem inalterados.
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
        <Card title="Nova categoria">
          <form action={createReceivableCategoryAction} className="grid gap-4 md:grid-cols-4">
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
