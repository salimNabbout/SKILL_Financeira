import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { BASE, ExportLink, FluxoTabs } from "../_lib/shared";
import { ImportForm } from "./_lib/import-form";

/**
 * Importar planilha — lê a aba Lançamentos da pasta exportada pelo app,
 * valida tudo (relatório linha a linha) e, só depois da confirmação, grava
 * as linhas novas como ajustes manuais (tudo-ou-nada). Página, não modal:
 * todas as telas são Server Components; o formulário é o único trecho cliente.
 */
export default async function ImportarPlanilhaPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; ok?: string; erro?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const ano = Number(sp.ano) || new Date().getFullYear();
  const podeImportar = hasPermission(session.membership.role, "budget.manage");

  return (
    <div>
      <PageHeader
        title="Importar planilha do Fluxo de Caixa"
        subtitle="Envie a planilha exportada pelo app (ou uma cópia com linhas novas na aba Lançamentos), confira o relatório e confirme. Nada é gravado antes da confirmação."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportLink ano={ano} />
            <Link href={`${BASE}/lancamentos?ano=${ano}`} className="text-sm text-[var(--brand)] underline">
              ← Lançamentos
            </Link>
          </div>
        }
      />
      <FluxoTabs active="lancamentos" ano={ano} />
      <Flash ok={sp.ok} erro={sp.erro} />
      {!podeImportar ? (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite gravar ajustes manuais no fluxo de caixa — a importação está desabilitada.
        </p>
      ) : null}
      <ImportForm ano={ano} podeImportar={podeImportar} />
    </div>
  );
}
