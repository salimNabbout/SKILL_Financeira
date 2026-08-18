import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createCostCenterAction } from "./actions";

export default async function CentrosDeCustoPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
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
          <Table headers={["Código", "Nome", "Situação"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>
                  <span className="tabular">{c.code}</span>
                </Td>
                <Td>{c.name}</Td>
                <Td>
                  <Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "Ativo" : "Inativo"}</Badge>
                </Td>
              </tr>
            ))}
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
