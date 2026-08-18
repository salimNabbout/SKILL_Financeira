import { decideApproval } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * POST /api/v1/approvals/:id/decide — { decision: "approved"|"rejected", justification? }.
 * Alçada e segregação de funções são verificadas pelo orquestrador; se a aprovação
 * pertencer a um fluxo suspenso, ele é retomado e a resposta consolidada é devolvida.
 */
export const POST = withAuth<{ id: string }>(async (req, { session, container, params }) =>
  json(await decideApproval(container, session, params.id, await readJson(req)))
);
