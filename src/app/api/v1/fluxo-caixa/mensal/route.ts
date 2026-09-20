import { getCashflowMonthly } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/mensal?ano= — grade 12 meses × categorias, subtotais, resultado e saldo encadeado. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getCashflowMonthly(container, session, queryOf(req)))
);
