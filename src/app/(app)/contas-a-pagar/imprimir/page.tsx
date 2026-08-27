import Link from "next/link";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import { describeFilters, parsePayableFilters } from "../_lib/filters";
import { PAYABLE_EXPORT_COLUMNS, payablesToExportRows, totalsOf } from "../_lib/export-rows";
import { loadFilteredPayables } from "../_lib/load-filtered";
import { DispararImpressao } from "./_lib/disparar-impressao";

/**
 * Visão de impressão de Contas a Pagar: só o cabeçalho, a tabela filtrada e os
 * totais. Sem menu, filtros, botões de ação ou paginação — o que a pessoa
 * segura no papel é o relatório, não a interface.
 *
 * Server Component; apenas o disparo de window.print() é cliente.
 */
export default async function ImprimirContasAPagarPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    ano?: string;
    mes?: string;
    fornecedor?: string;
    de?: string;
    ate?: string;
  }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();

  const filtros = parsePayableFilters(sp);
  const dados = await loadFilteredPayables(repos, session.company.id, filtros);
  const rows = payablesToExportRows(dados.payables, dados.lookups);
  const totais = totalsOf(dados.payables);

  const geradoEm = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: session.config.timezone,
  }).format(new Date());

  return (
    <div className="print-root">
      {/* Paisagem, cabeçalho de tabela repetido em cada página e linhas que não
          se partem ao meio. A barra de ações some na impressão. */}
      <style>{`
        @page { size: A4 landscape; margin: 12mm; }
        @media print {
          .nao-imprimir { display: none !important; }
          .print-root { padding: 0 !important; }
          thead { display: table-header-group; }
          tfoot { display: table-footer-group; }
          tr { break-inside: avoid; page-break-inside: avoid; }
          table { width: 100%; border-collapse: collapse; }
          body { background: #fff; }
        }
      `}</style>

      <DispararImpressao />

      <div className="nao-imprimir mb-4 flex flex-wrap items-center gap-3">
        <Link href="/contas-a-pagar" className="text-sm text-[var(--brand)] underline">
          ← Voltar para Contas a pagar
        </Link>
        <span className="text-xs text-[var(--ink-muted)]">
          A janela de impressão abre sozinha. Selecione &quot;Paisagem&quot; se o navegador não
          aplicar automaticamente.
        </span>
      </div>

      <header className="mb-4">
        <h1 className="text-xl font-semibold">{session.company.name}</h1>
        <p className="text-lg">Contas a Pagar</p>
        <p className="text-xs text-[var(--ink-muted)]">
          {describeFilters(filtros, dados.supplierNameFiltrado)}
        </p>
        <p className="text-xs text-[var(--ink-muted)]">Gerado em {geradoEm}</p>
      </header>

      {dados.truncado ? (
        <p className="nao-imprimir mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          O filtro atual retorna mais títulos do que o limite de impressão. Restrinja o período
          para incluir todos.
        </p>
      ) : null}

      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {PAYABLE_EXPORT_COLUMNS.map((c) => (
              <th
                key={c}
                className="border-b border-[var(--line-print,#999)] px-1.5 py-1 text-left font-semibold"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 === 1 ? "bg-[#f2f2f2]" : ""}>
              {PAYABLE_EXPORT_COLUMNS.map((c) => (
                <td
                  key={c}
                  className={`px-1.5 py-1 align-top ${
                    c === "Valor (R$)" || c === "Valor Pago (R$)" ? "text-right tabular" : ""
                  }`}
                >
                  {r[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className="border-t border-[#999] px-1.5 py-1" colSpan={9}>
              TOTAL — {totais.quantidade} título(s)
            </td>
            <td className="border-t border-[#999] px-1.5 py-1 text-right tabular">
              {formatBRL(totais.valorCents)}
            </td>
            <td className="border-t border-[#999] px-1.5 py-1 text-right tabular">
              {formatBRL(totais.pagoCents)}
            </td>
            <td className="border-t border-[#999]" colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
