import { requireSession } from "@/lib/session";
import { buildImportTemplate } from "../../_lib/import-csv";

export const runtime = "nodejs";

/**
 * GET /contas-a-pagar/importar/modelo
 * Modelo CSV da importação, com uma linha de exemplo preenchida.
 */
export async function GET(): Promise<Response> {
  await requireSession();
  return new Response(buildImportTemplate(), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="modelo-contas-a-pagar.csv"',
    },
  });
}
