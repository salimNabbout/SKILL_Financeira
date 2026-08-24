import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createCostCenterAction, updateCostCenterAction } from "./actions";

const PATH = "/cadastros/centros-de-custo";

/** Rótulo do destino do centro de custo (campo `scope`). */
const DESTINO: Record<string, string> = {
  payable: "Contas a pagar",
  receivable: "Contas a receber",
  both: "Ambos",
};

export default async function CentrosDeCustoPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; editar?: string }>;
}) {
  const { ok, erro, editar } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const costCenters = await repos.costCenters.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...costCenters].sort((a, b) => a.code.localeCompare(b.code, "pt-BR"));

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
          <Table
            headers={
              canManage
                ? ["Código", "Nome", "Destino", "Situação", "Ações"]
                : ["Código", "Nome", "Destino", "Situação"]
            }
          >
            {rows.map((c) =>
              canManage && editar === c.id ? (
                // Edição inline sem estado no cliente: ?editar=<id> escolhe a
                // linha e a página segue Server Component.
                <tr key={c.id}>
                  <Td colSpan={5}>
                    <form action={updateCostCenterAction} className="grid gap-3 md:grid-cols-5">
                      <input type="hidden" name="id" value={c.id} />
                      <Field label="Código">
                        <input name="code" required defaultValue={c.code} className={inputClass} />
                      </Field>
                      <Field label="Nome">
                        <input name="name" required defaultValue={c.name} className={inputClass} />
                      </Field>
                      <Field label="Destino">
                        <select name="scope" defaultValue={c.scope} className={inputClass}>
                          <option value="payable">Contas a pagar</option>
                          <option value="receivable">Contas a receber</option>
                          <option value="both">Ambos</option>
                        </select>
                      </Field>
                      <Field label="Situação">
                        <select
                          name="active"
                          defaultValue={c.active ? "true" : "false"}
                          className={inputClass}
                        >
                          <option value="true">Ativo</option>
                          <option value="false">Inativo</option>
                        </select>
                      </Field>
                      <div className="flex items-end gap-3">
                        <Button>Salvar</Button>
                        <Link href={PATH} className="text-xs text-[var(--ink-muted)] underline">
                          Cancelar
                        </Link>
                      </div>
                    </form>
                  </Td>
                </tr>
              ) : (
                <tr key={c.id}>
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
                    <Td>
                      <form method="get" action={PATH}>
                        <input type="hidden" name="editar" value={c.id} />
                        <Button variant="warn">Editar</Button>
                      </form>
                    </Td>
                  ) : null}
                </tr>
              )
            )}
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
                <option value="payable">Contas a pagar</option>
                <option value="receivable">Contas a receber</option>
                <option value="both">Ambos</option>
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
