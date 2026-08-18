import { withAuth } from "@/app/api/_lib/http";
import { json, publicCompany } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/companies/current — empresa da sessão atual. */
export const GET = withAuth(async (_req, { session }) => json(publicCompany(session.company)));
