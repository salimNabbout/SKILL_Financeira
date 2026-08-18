import { createCategory, listCategories } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/categories — categorias da empresa da sessão. */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listCategories(container, session))
);

/** POST /api/v1/categories — cria categoria (idempotente por nome+tipo). 201 criado, 200 replay. */
export const POST = withAuth(async (req, { session, container }) => {
  const { entity, created } = await createCategory(container, session, await readJson(req));
  return json(entity, created ? 201 : 200);
});
