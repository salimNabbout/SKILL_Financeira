import { listSkills } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/skills — catálogo público das skills registradas (contrato). */
export const GET = withAuth(async (_req, { container }) => json(listSkills(container)));
