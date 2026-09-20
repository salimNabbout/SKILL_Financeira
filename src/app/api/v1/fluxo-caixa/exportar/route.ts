import { exportCashflowWorkbook } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";

export const runtime = "nodejs";

/**
 * GET /api/v1/fluxo-caixa/exportar?ano=&formato=xlsx
 *
 * Baixa a pasta "Fluxo de Caixa CETEM" (7 abas, fórmulas vivas, sem macros)
 * com os dados reais do ano base. Só leitura: nada é gravado.
 */
export const GET = withAuth(async (req, { session, container }) => {
  const file = await exportCashflowWorkbook(container, session, queryOf(req));
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
