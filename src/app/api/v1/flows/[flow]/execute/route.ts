import { executeFlow } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * POST /api/v1/flows/:flow/execute — porta de entrada do orquestrador.
 * Corpo: { payload, idempotencyKey? }. Resposta: OrchestratorResponse completa
 * (resultados por passo, visão consolidada, aprovação pendente se houver).
 */
export const POST = withAuth<{ flow: string }>(async (req, { session, container, params }) =>
  json(await executeFlow(container, session, params.flow, await readJson(req)))
);
