import { getContainer } from "@/lib/container";
import { todayInTz } from "@/core/dates";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { toCsv } from "@/lib/exporters/csv";
import { parsePayableFilters } from "../_lib/filters";
import {
  PAYABLE_CSV_COLUMNS,
  PAYABLE_CSV_TEXT_COLUMNS,
  payablesToExportRows,
} from "../_lib/export-rows";
import { loadFilteredPayables } from "../_lib/load-filtered";

export const runtime = "nodejs";

/**
 * GET /contas-a-pagar/export?<mesmos filtros da listagem>
 *
 * Exporta em CSV TODOS os títulos que atendem aos filtros da tela — não só a
 * página visível. Os filtros são reinterpretados pela mesma função que a
 * página usa, então o arquivo corresponde exatamente ao que está sendo
 * mostrado. (O modo PDF foi retirado; a visão de impressão continua em
 * /contas-a-pagar/imprimir.)
 */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  // Mesma permissão exigida para ver a tela.
  if (!hasPermission(session.membership.role, "report.view")) {
    return new Response("Sem permissão.", { status: 403 });
  }

  const url = new URL(req.url);
  const sp = Object.fromEntries(url.searchParams.entries());
  const container = await getContainer();
  const today = todayInTz(container.clock.now(), session.config.timezone);
  const filtros = parsePayableFilters(sp, today);
  if (filtros.periodoInvalido) {
    return new Response("Data inicial maior que a final.", { status: 400 });
  }

  const dados = await loadFilteredPayables(
    container.repos,
    session.company.id,
    filtros,
    session.config.timezone
  );
  const rows = payablesToExportRows(dados.payables, dados.lookups);

  const hoje = new Date().toISOString().slice(0, 10);

  // CSV: colunas da impressão + "Data de Pagamento"; Parcela forçada como
  // texto para o Excel não transformar "1/17" em data.
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
