import { listEvents } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/events?type= — outbox de eventos de domínio da empresa. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listEvents(container, session, queryOf(req)))
);
