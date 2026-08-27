import { getContainer } from "@/lib/container";
import { todayInTz } from "@/core/dates";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { toCsv } from "@/lib/exporters/csv";
import { buildPdfReport } from "@/lib/exporters/pdf";
import { formatBRL } from "@/lib/format";
import { describeFilters, parseReceivableFilters } from "../_lib/filters";
import { RECEIVABLE_EXPORT_COLUMNS, receivablesToExportRows, totalsOf } from "../_lib/export-rows";
import { loadFilteredReceivables } from "../_lib/load-filtered";

export const runtime = "nodejs";

/**
 * GET /contas-a-receber/export?format=csv|pdf&<mesmos filtros da listagem>
 *
 * Exporta TODOS os títulos que atendem aos filtros da tela — não só a página
 * visível. Os filtros são reinterpretados pela mesma função que a página usa,
 * então o arquivo corresponde exatamente ao que está sendo mostrado.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  if (!hasPermission(session.membership.role, "report.view")) {
    return new Response("Sem permissão.", { status: 403 });
  }

  const url = new URL(req.url);
  const sp = Object.fromEntries(url.searchParams.entries());
  const container = await getContainer();
  const today = todayInTz(container.clock.now(), session.config.timezone);
  const filtros = parseReceivableFilters(sp, today);
  if (filtros.periodoInvalido) {
    return new Response("Data inicial maior que a final.", { status: 400 });
  }

  const dados = await loadFilteredReceivables(container.repos, session.company.id, filtros);
  const rows = receivablesToExportRows(dados.receivables, dados.lookups);
  const totais = totalsOf(dados.receivables);

  const hoje = new Date().toISOString().slice(0, 10);
  const formato = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";

  if (formato === "csv") {
    const conteudo = toCsv(
      rows,
      RECEIVABLE_EXPORT_COLUMNS.map((c) => ({ key: c, label: c }))
    );
    return new Response(conteudo, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="contas-a-receber_${hoje}.csv"`,
      },
    });
  }

  const totalsRow = RECEIVABLE_EXPORT_COLUMNS.map((coluna) => {
    if (coluna === "Cliente") return `TOTAL — ${totais.quantidade} título(s)`;
    if (coluna === "Valor (R$)") return formatBRL(totais.valorCents).replace("R$", "").trim();
    if (coluna === "Valor Recebido (R$)") {
      return formatBRL(totais.recebidoCents).replace("R$", "").trim();
    }
    return "";
  });

  const bytes = await buildPdfReport({
    title: "Contas a Receber",
    subtitle: session.company.name,
    orientation: "landscape",
    filtersLabel: describeFilters(filtros, dados.customerNameFiltrado),
    sections: [
      {
        heading: `${totais.quantidade} título(s)`,
        table: {
          headers: [...RECEIVABLE_EXPORT_COLUMNS],
          rows: rows.map((r) => RECEIVABLE_EXPORT_COLUMNS.map((c) => r[c])),
          statusColumnIndex: RECEIVABLE_EXPORT_COLUMNS.indexOf("Status"),
          totalsRow,
        },
      },
    ],
  });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="contas-a-receber_${hoje}.pdf"`,
    },
  });
}
