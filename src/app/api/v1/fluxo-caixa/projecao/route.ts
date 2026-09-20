import { getCashflowProjection } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/projecao?ano=&cenario= — 12 meses por cenário (todos, ou só o pedido). */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getCashflowProjection(container, session, queryOf(req)))
);
