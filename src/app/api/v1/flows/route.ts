import { listFlows } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/flows — fluxos disponíveis do orquestrador (passos e permissão exigida). */
export const GET = withAuth(async (_req, { container }) => json(listFlows(container)));
