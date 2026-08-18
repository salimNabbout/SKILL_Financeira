import { createCustomer, listCustomers } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/customers — clientes da empresa da sessão. */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listCustomers(container, session))
);

/** POST /api/v1/customers — cria cliente (idempotente por documento/nome). 201 criado, 200 replay. */
export const POST = withAuth(async (req, { session, container }) => {
  const { entity, created } = await createCustomer(container, session, await readJson(req));
  return json(entity, created ? 201 : 200);
});
