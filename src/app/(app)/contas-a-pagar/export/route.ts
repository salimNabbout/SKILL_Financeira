import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { toCsv } from "@/lib/exporters/csv";
import { buildPdfReport } from "@/lib/exporters/pdf";
import { formatBRL } from "@/lib/format";
import { describeFilters, parsePayableFilters } from "../_lib/filters";
import {
  PAYABLE_EXPORT_COLUMNS,
  payablesToExportRows,
  totalsOf,
} from "../_lib/export-rows";
import { loadFilteredPayables } from "../_lib/load-filtered";

export const runtime = "nodejs";

/**
 * GET /contas-a-pagar/export?format=csv|pdf&<mesmos filtros da listagem>
 *
 * Exporta TODOS os títulos que atendem aos filtros da tela — não só a página
 * visível. Os filtros são reinterpretados pela mesma função que a página usa,
 * então o arquivo corresponde exatamente ao que está sendo mostrado.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  // Mesma permissão exigida para ver a tela.
  if (!hasPermission(session.membership.role, "report.view")) {
    return new Response("Sem permissão.", { status: 403 });
  }

  const url = new URL(req.url);
  const sp = Object.fromEntries(url.searchParams.entries());
  const filtros = parsePayableFilters(sp);
  if (filtros.periodoInvalido) {
    return new Response("Data inicial maior que a final.", { status: 400 });
  }

  const container = await getContainer();
  const dados = await loadFilteredPayables(container.repos, session.company.id, filtros);
  const rows = payablesToExportRows(dados.payables, dados.lookups);
  const totais = totalsOf(dados.payables);

  const hoje = new Date().toISOString().slice(0, 10);
  const formato = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";

  if (formato === "csv") {
    const conteudo = toCsv(
      rows,
      PAYABLE_EXPORT_COLUMNS.map((c) => ({ key: c, label: c }))
    );
    return new Response(conteudo, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="contas-a-pagar_${hoje}.csv"`,
      },
    });
  }

  const bytes = await buildPdfReport({
    title: "Contas a Pagar",
    subtitle: session.company.name,
    orientation: "landscape",
    filtersLabel: describeFilters(filtros, dados.supplierNameFiltrado),
    sections: [
      {
        heading: `${totais.quantidade} título(s)`,
        table: {
          headers: [...PAYABLE_EXPORT_COLUMNS],
          rows: rows.map((r) => PAYABLE_EXPORT_COLUMNS.map((c) => r[c])),
          // Colore a coluna Status conforme a situação do título.
          statusColumnIndex: PAYABLE_EXPORT_COLUMNS.indexOf("Status"),
          totalsRow: [
            `TOTAL — ${totais.quantidade} título(s)`,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            formatBRL(totais.valorCents).replace("R$", "").trim(),
            formatBRL(totais.pagoCents).replace("R$", "").trim(),
            "",
            "",
          ],
        },
      },
    ],
  });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="contas-a-pagar_${hoje}.pdf"`,
    },
  });
}
