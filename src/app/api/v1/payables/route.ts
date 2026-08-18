import { listPayables } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/payables?status=&from=&to= — títulos a pagar (filtros por status e vencimento). */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listPayables(container, session, queryOf(req)))
);
