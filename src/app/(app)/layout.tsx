import Link from "next/link";
import { requireSession } from "@/lib/session";
import { isDemoMode } from "@/lib/container";
import { logoutAction } from "@/app/login/actions";
import { ROLE_LABELS } from "@/lib/format";

const NAV: Array<{ href: string; label: string }> = [
  { href: "/", label: "Dashboard" },
  { href: "/contas-a-pagar", label: "Contas a pagar" },
  { href: "/contas-a-receber", label: "Contas a receber" },
  { href: "/faturamento", label: "Faturamento" },
  { href: "/fluxo-de-caixa", label: "Fluxo de caixa" },
  { href: "/conciliacao", label: "Conciliação" },
  { href: "/cobranca", label: "Cobrança" },
  { href: "/orcamento", label: "Orçamento" },
  { href: "/dre", label: "DRE gerencial" },
  { href: "/indicadores", label: "Indicadores" },
  { href: "/aprovacoes", label: "Aprovações" },
  { href: "/alertas", label: "Alertas e pendências" },
  { href: "/relatorios", label: "Relatórios" },
  { href: "/cadastros", label: "Cadastros" },
  { href: "/auditoria", label: "Auditoria" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--line)] bg-white p-4 md:block">
        <div className="mb-6">
          <p className="text-lg font-semibold text-[var(--brand)]">Financeira PME</p>
          <p className="text-xs text-[var(--ink-muted)]">{session.company.name}</p>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-lg px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-slate-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-8 border-t border-[var(--line)] pt-4 text-xs text-[var(--ink-muted)]">
          <p className="font-medium text-[var(--ink)]">{session.user.name}</p>
          <p>{ROLE_LABELS[session.membership.role] ?? session.membership.role}</p>
          <form action={logoutAction} className="mt-2">
            <button type="submit" className="text-[var(--brand)] hover:underline">
              Sair
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        {isDemoMode() ? (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Modo demonstração: dados fictícios em memória (reiniciam ao reiniciar o servidor).
            Integrações bancárias, NF-e e envio de mensagens são <strong>mocks identificados</strong>.
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}
