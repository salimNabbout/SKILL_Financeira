import { getMe } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/me — usuário (sem hash), empresa e papel da sessão atual. */
export const GET = withAuth(async (_req, { session }) => json(getMe(session)));
