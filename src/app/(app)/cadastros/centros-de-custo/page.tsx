import { Fragment } from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";

/** Rótulo do destino do centro de custo (campo `scope`). */
const DESTINO: Record<string, string> = {
  payable: "Contas a pagar",
  receivable: "Contas a receber",
  both: "Ambos",
};

/** Opções do seletor de destino, na mesma ordem nos dois formulários. */
function OpcoesDestino() {
  return (
    <>
      <option value="payable">Contas a pagar</option>
      <option value="receivable">Contas a receber</option>
      <option value="both">Ambos</option>
    </>
  );
}
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import {
  createCostCenterAction,
  deactivateCostCenterAction,
  reactivateCostCenterAction,
  updateCostCenterAction,
} from "./actions";
import { countCostCenterLinks } from "./_lib/update";

export default async function CentrosDeCustoPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; editar?: string; excluir?: string }>;
}) {
  const sp = await searchParams;
  const { ok, erro } = sp;
  const editar = sp.editar?.trim() || undefined;
  const excluir = sp.excluir?.trim() || undefined;
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;
  const costCenters = await container.repos.costCenters.listAll(companyId);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...costCenters].sort((a, b) => a.code.localeCompare(b.code, "pt-BR"));

  // Contagem de vínculos só do centro em confirmação de exclusão (evita N×3 queries).
  const excluirTarget = excluir ? rows.find((c) => c.id === excluir) : undefined;
  const excluirLinks =
    excluirTarget && canManage
      ? await countCostCenterLinks(container, companyId, excluirTarget.id)
      : 0;

  return (
    <div>
      <PageHeader
        title="Centros de custo"
        subtitle="Alocação de custos por área, projeto ou unidade."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum centro de custo cadastrado." />
        ) : (
          <Table headers={["Código", "Nome", "Destino", "Situação", ...(canManage ? ["Ações"] : [])]}>
            {rows.map((c) => {
              const editing = editar === c.id;
              const excluding = excluir === c.id;
              return (
                <Fragment key={c.id}>
                  <tr>
                    <Td>
                      <span className="tabular">{c.code}</span>
                    </Td>
                    <Td>{c.name}</Td>
                    <Td>
                      <Badge tone={c.scope === "both" ? "brand" : "neutral"}>
                        {DESTINO[c.scope] ?? c.scope}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "Ativo" : "Inativo"}</Badge>
                    </Td>
                    {canManage ? (
                      <Td className="whitespace-nowrap">
                        {/* Mesmo padrão de /contas-a-pagar: botões compactos que abrem/fecham
                            o form inline via GET (?editar / ?excluir), sem client/useState.
                            Centro inativo troca "Excluir" por "Reativar" (danger→warn). */}
                        <div className="flex flex-nowrap items-center gap-1">
                          <form method="get" action="/cadastros/centros-de-custo" className="inline">
                            <input type="hidden" name="editar" value={editing ? "" : c.id} />
                            <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                              <Button variant="warn" type="submit">
                                {editing ? "Fechar" : "✎ Editar"}
                              </Button>
                            </span>
                          </form>
                          {c.active ? (
                            <form method="get" action="/cadastros/centros-de-custo" className="inline">
                              <input type="hidden" name="excluir" value={excluding ? "" : c.id} />
                              <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                <Button variant="danger" type="submit">
                                  {excluding ? "Fechar" : "🗑 Excluir"}
                                </Button>
                              </span>
                            </form>
                          ) : (
                            // Reativar um centro inativo (ação direta, sem confirmação).
                            <form action={reactivateCostCenterAction} className="inline">
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

                  {editing && canManage ? (
                    <tr>
                      {/* <td> cru para colSpan — o Td compartilhado não o expõe. */}
                      <td className="px-3 py-3 align-top" colSpan={4}>
                        <form
                          action={updateCostCenterAction}
                          className="grid gap-3 rounded-lg border border-[var(--line)] bg-slate-50 p-3 md:grid-cols-3"
                        >
                          <input type="hidden" name="id" value={c.id} />
                          <Field label="Código">
                            <input name="code" required defaultValue={c.code} className={inputClass} />
                          </Field>
                          <Field label="Nome">
                            <input name="name" required defaultValue={c.name} className={inputClass} />
                          </Field>
                          <Field label="Destino">
                            <select name="scope" defaultValue={c.scope} className={inputClass}>
                              <OpcoesDestino />
                            </select>
                          </Field>
                          <div className="flex items-end gap-2">
                            <Button variant="warn" type="submit">
                              Salvar
                            </Button>
                            <Link
                              href="/cadastros/centros-de-custo"
                              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
                            >
                              Cancelar
                            </Link>
                          </div>
                        </form>
                      </td>
                    </tr>
                  ) : null}

                  {excluding && canManage ? (
                    <tr>
                      <td className="px-3 py-3 align-top" colSpan={4}>
                        <form
                          action={deactivateCostCenterAction}
                          className="rounded-lg border border-red-200 bg-red-50 p-3"
                        >
                          <input type="hidden" name="id" value={c.id} />
                          <p className="mb-3 text-sm text-[var(--crit)]">
                            Este centro de custo está vinculado a {excluirLinks} lançamento
                            {excluirLinks === 1 ? "" : "s"}. Ele será desativado e deixará de
                            aparecer em novos lançamentos, mas os registros existentes permanecem
                            inalterados.
                          </p>
                          <div className="flex items-center gap-2">
                            <Button variant="danger" type="submit">
                              Confirmar desativação
                            </Button>
                            <Link
                              href="/cadastros/centros-de-custo"
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
        <Card title="Novo centro de custo">
          <form action={createCostCenterAction} className="grid gap-4 md:grid-cols-3">
            <Field label="Código">
              <input name="code" required className={inputClass} placeholder="Ex.: CC-01" />
            </Field>
            <Field label="Nome">
              <input name="name" required className={inputClass} placeholder="Ex.: Comercial" />
            </Field>
            <Field label="Destino">
              <select name="scope" defaultValue="both" className={inputClass}>
                <OpcoesDestino />
              </select>
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
