import { listCompanies } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/companies — empresas do usuário autenticado (via memberships). */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listCompanies(container, session))
);
