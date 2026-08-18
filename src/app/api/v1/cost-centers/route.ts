import { createCostCenter, listCostCenters } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/cost-centers — centros de custo da empresa da sessão. */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listCostCenters(container, session))
);

/** POST /api/v1/cost-centers — cria centro de custo (idempotente por código). 201 criado, 200 replay. */
export const POST = withAuth(async (req, { session, container }) => {
  const { entity, created } = await createCostCenter(container, session, await readJson(req));
  return json(entity, created ? 201 : 200);
});
