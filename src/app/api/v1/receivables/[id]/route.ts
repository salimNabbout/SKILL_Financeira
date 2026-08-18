import { getReceivable } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/receivables/:id — título a receber com seus recebimentos. */
export const GET = withAuth<{ id: string }>(async (_req, { session, container, params }) =>
  json(await getReceivable(container, session, params.id))
);
