import { listApprovals } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/approvals?status= — aprovações da empresa (mais recentes primeiro). */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listApprovals(container, session, queryOf(req)))
);
