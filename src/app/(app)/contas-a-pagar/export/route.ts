import { getContainer } from "@/lib/container";
import { todayInTz } from "@/core/dates";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { toCsv } from "@/lib/exporters/csv";
import { buildPdfReport } from "@/lib/exporters/pdf";
import { formatBRL } from "@/lib/format";
import { describeFilters, parsePayableFilters } from "../_lib/filters";
import {
  PAYABLE_CSV_COLUMNS,
  PAYABLE_CSV_TEXT_COLUMNS,
  PAYABLE_EXPORT_COLUMNS,
  payablesToExportRows,
  totalsLabel,
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
  const container0 = await getContainer();
  const today = todayInTz(container0.clock.now(), session.config.timezone);
  const filtros = parsePayableFilters(sp, today);
  if (filtros.periodoInvalido) {
    return new Response("Data inicial maior que a final.", { status: 400 });
  }

  const container = container0;
  const dados = await loadFilteredPayables(
    container.repos,
    session.company.id,
    filtros,
    session.config.timezone
  );
  const rows = payablesToExportRows(dados.payables, dados.lookups);
  const totais = totalsOf(dados.payables);

  const hoje = new Date().toISOString().slice(0, 10);
  const formato = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";

  if (formato === "csv") {
    // CSV: colunas do PDF + "Data de Pagamento"; Parcela forçada como texto
    // para o Excel não transformar "1/17" em data.
    const conteudo = toCsv(
      rows,
      PAYABLE_CSV_COLUMNS.map((c) => ({
        key: c,
        label: c,
        forceText: PAYABLE_CSV_TEXT_COLUMNS.has(c),
      }))
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
        heading: `${rows.length} título(s)`,
        table: {
          headers: [...PAYABLE_EXPORT_COLUMNS],
          rows: rows.map((r) => PAYABLE_EXPORT_COLUMNS.map((c) => r[c])),
          // Colore a coluna Status conforme a situação do título.
          statusColumnIndex: PAYABLE_EXPORT_COLUMNS.indexOf("Status"),
          totalsRow: [
            totalsLabel(totais),
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
