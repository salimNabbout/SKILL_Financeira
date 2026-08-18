import { getPayable } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/payables/:id — título a pagar com seus pagamentos. */
export const GET = withAuth<{ id: string }>(async (_req, { session, container, params }) =>
  json(await getPayable(container, session, params.id))
);
