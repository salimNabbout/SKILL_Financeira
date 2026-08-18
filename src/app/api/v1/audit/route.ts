import { getAuditTrail } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/audit?entityType=&entityId= — trilha de auditoria imutável (exige audit.view). */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getAuditTrail(container, session, queryOf(req)))
);
