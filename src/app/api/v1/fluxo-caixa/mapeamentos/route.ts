import { listCashflowMappings, putCashflowMapping } from "@/app/api/_lib/cashflow";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/mapeamentos — de-para da empresa. */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listCashflowMappings(container, session))
);

/** PUT /api/v1/fluxo-caixa/mapeamentos — cria (201) ou atualiza (200) o de-para de uma chave. */
export const PUT = withAuth(async (req, { session, container }) => {
  const { entity, created } = await putCashflowMapping(container, session, await readJson(req));
  return json(entity, created ? 201 : 200);
});
