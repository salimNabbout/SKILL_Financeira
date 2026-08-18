import { acknowledgeAlert } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** POST /api/v1/alerts/:id/ack — marca o alerta como ciente (idempotente). */
export const POST = withAuth<{ id: string }>(async (_req, { session, container, params }) => {
  const { entity } = await acknowledgeAlert(container, session, params.id);
  return json(entity);
});
