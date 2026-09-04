import { registerUiEvents } from "@/app/api/_lib/ui-events";
import { clientMeta, readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * POST /api/v1/ui-events — lote de eventos de atividade do front-end
 * (cliques, submissões, navegação). Estas requisições NÃO geram evento
 * "requisicao" próprio (excluídas no withAuth).
 */
export const POST = withAuth(async (req, { session, container }) =>
  json(
    await registerUiEvents(container.activity, session, await readJson(req), clientMeta(req)),
    202
  )
);
