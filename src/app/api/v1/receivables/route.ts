import { listReceivables } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/receivables?status=&from=&to= — títulos a receber (filtros por status e vencimento). */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listReceivables(container, session, queryOf(req)))
);
