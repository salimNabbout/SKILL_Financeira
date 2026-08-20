import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { toCsv } from "@/lib/exporters/csv";
import { buildPdfReport } from "@/lib/exporters/pdf";
import { SUPPLIER_CSV_COLUMNS, suppliersToCsvRows } from "../_lib/csv";

export const runtime = "nodejs";

/**
 * GET /cadastros/fornecedores/export?format=csv|pdf
 * Baixa a lista de fornecedores da empresa em CSV (Excel pt-BR) ou PDF.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await requireSession();
  if (!hasPermission(session.membership.role, "master_data.manage")) {
    return new Response("Sem permissão.", { status: 403 });
  }
  const { repos } = await getContainer();
  const suppliers = [...(await repos.suppliers.listAll(session.company.id))].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR")
  );

  const format = new URL(req.url).searchParams.get("format") === "pdf" ? "pdf" : "csv";
  const rows = suppliersToCsvRows(suppliers);

  if (format === "csv") {
    const content = toCsv(
      rows,
      SUPPLIER_CSV_COLUMNS.map((c) => ({ key: c, label: c }))
    );
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fornecedores.csv"`,
      },
    });
  }

  const bytes = await buildPdfReport({
    title: "Fornecedores",
    subtitle: session.company.name,
    sections: [
      {
        heading: `${rows.length} fornecedor(es)`,
        table: {
          headers: [...SUPPLIER_CSV_COLUMNS],
          rows: rows.map((r) => SUPPLIER_CSV_COLUMNS.map((c) => r[c] ?? "")),
        },
      },
    ],
  });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="fornecedores.pdf"`,
    },
  });
}
