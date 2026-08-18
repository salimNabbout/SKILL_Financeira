import { createSupplier, listSuppliers } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/suppliers — fornecedores da empresa da sessão (dados bancários mascarados). */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listSuppliers(container, session))
);

/** POST /api/v1/suppliers — cria fornecedor (idempotente por documento/nome). 201 criado, 200 replay. */
export const POST = withAuth(async (req, { session, container }) => {
  const { entity, created } = await createSupplier(container, session, await readJson(req));
  return json(entity, created ? 201 : 200);
});
