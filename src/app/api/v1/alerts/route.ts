import { listAlerts } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/alerts?status= — central de alertas/pendências da empresa. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listAlerts(container, session, queryOf(req)))
);
