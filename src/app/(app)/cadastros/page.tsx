import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";

export default async function CadastrosPage() {
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const [
    customers,
    suppliers,
    supplierCategories,
    bankAccounts,
    categories,
    costCenters,
    chartAccounts,
    memberships,
  ] = await Promise.all([
    repos.customers.listAll(companyId),
    repos.suppliers.listAll(companyId),
    repos.supplierCategories.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
    repos.categories.listAll(companyId),
    repos.costCenters.listAll(companyId),
    repos.chartAccounts.listAll(companyId),
    repos.memberships.listByCompany(companyId),
  ]);

  const cards: Array<{ href: string; title: string; description: string; count: number }> = [
    { href: "/cadastros/clientes", title: "Clientes", description: "Quem compra da empresa — base de contas a receber e cobrança.", count: customers.length },
    { href: "/cadastros/fornecedores", title: "Fornecedores", description: "Quem fornece à empresa — base de contas a pagar.", count: suppliers.length },
    { href: "/cadastros/categorias-fornecedores", title: "Categoria de Fornecedores", description: "Lista de categorias que alimenta o campo CATEGORIA do fornecedor.", count: supplierCategories.length },
    { href: "/cadastros/contas-bancarias", title: "Contas bancárias", description: "Contas da empresa (números sempre mascarados).", count: bankAccounts.length },
    { href: "/cadastros/categorias", title: "Categorias", description: "Classificação de receitas e despesas por grupo do DRE.", count: categories.length },
    { href: "/cadastros/centros-de-custo", title: "Centros de custo", description: "Alocação de custos por área ou projeto.", count: costCenters.length },
    { href: "/cadastros/plano-de-contas", title: "Plano de contas", description: "Estrutura contábil para exportação à contabilidade.", count: chartAccounts.length },
    { href: "/cadastros/usuarios", title: "Usuários", description: "Pessoas com acesso, papéis e limites de alçada.", count: memberships.length },
  ];

  return (
    <div>
      <PageHeader title="Cadastros" subtitle="Dados mestres da empresa — a base de todos os fluxos financeiros." />
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card block p-4 transition hover:border-[var(--brand)]">
            <div className="flex items-start justify-between">
              <h2 className="text-base font-semibold">{c.title}</h2>
              <span className="tabular rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                {c.count}
              </span>
            </div>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">{c.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
