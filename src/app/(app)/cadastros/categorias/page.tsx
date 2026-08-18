import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createCategoryAction } from "./actions";

const DRE_LABELS: Record<string, string> = {
  receita_bruta: "Receita bruta",
  deducoes: "Deduções",
  custos: "Custos",
  despesas_operacionais: "Despesas operacionais",
  despesas_financeiras: "Despesas financeiras",
  receitas_financeiras: "Receitas financeiras",
  outras: "Outras",
};

export default async function CategoriasPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const categories = await repos.categories.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "master_data.manage");
  const rows = [...categories].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "pt-BR")
  );

  return (
    <div>
      <PageHeader
        title="Categorias"
        subtitle="Classificação de receitas e despesas — base do DRE gerencial e do orçamento."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma categoria cadastrada." />
        ) : (
          <Table headers={["Nome", "Tipo", "Grupo do DRE", "Situação"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>{c.name}</Td>
                <Td>
                  <Badge tone={c.kind === "income" ? "ok" : "warn"}>
                    {c.kind === "income" ? "Receita" : "Despesa"}
                  </Badge>
                </Td>
                <Td>{DRE_LABELS[c.dreGroup] ?? c.dreGroup}</Td>
                <Td>
                  <Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "Ativa" : "Inativa"}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Nova categoria">
          <form action={createCategoryAction} className="grid gap-4 md:grid-cols-4">
            <Field label="Nome">
              <input name="name" required className={inputClass} />
            </Field>
            <Field label="Tipo">
              <select name="kind" required className={inputClass}>
                <option value="expense">Despesa</option>
                <option value="income">Receita</option>
              </select>
            </Field>
            <Field label="Grupo do DRE">
              <select name="dreGroup" required className={inputClass}>
                {Object.entries(DRE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
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
