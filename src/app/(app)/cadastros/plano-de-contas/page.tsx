import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createChartAccountAction } from "./actions";

const TYPE_LABELS: Record<string, string> = {
  asset: "Ativo",
  liability: "Passivo",
  equity: "Patrimônio líquido",
  revenue: "Receita",
  expense: "Despesa",
};

export default async function PlanoDeContasPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const accounts = await repos.chartAccounts.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...accounts].sort((a, b) => a.code.localeCompare(b.code, "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Plano de contas"
        subtitle="Estrutura contábil usada na preparação e exportação de lançamentos (validação final é do contador)."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma conta contábil cadastrada." />
        ) : (
          <Table headers={["Código", "Nome", "Tipo", "Conta pai", "Situação"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>
                  <span className="tabular">{c.code}</span>
                </Td>
                <Td>{c.name}</Td>
                <Td>{TYPE_LABELS[c.type] ?? c.type}</Td>
                <Td>{c.parentCode ?? "—"}</Td>
                <Td>
                  <Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "Ativa" : "Inativa"}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Nova conta contábil">
          <form action={createChartAccountAction} className="grid gap-4 md:grid-cols-4">
            <Field label="Código">
              <input name="code" required className={inputClass} placeholder="Ex.: 1.1.01" />
            </Field>
            <Field label="Nome">
              <input name="name" required className={inputClass} placeholder="Ex.: Caixa e equivalentes" />
            </Field>
            <Field label="Tipo">
              <select name="type" required className={inputClass}>
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Conta pai (opcional)">
              <input name="parentCode" className={inputClass} placeholder="Ex.: 1.1" />
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
