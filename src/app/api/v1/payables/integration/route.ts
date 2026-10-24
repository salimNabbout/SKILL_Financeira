import { listPayablesForIntegration } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * GET /api/v1/payables/integration?status=&from=&to=&limit=&offset= — visão mínima, somente leitura, dos títulos
 * a pagar para integrações (fornecedor nome/CNPJ, nº do documento, vencimento, valores, situação). Papel viewer basta.
 */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listPayablesForIntegration(container, session, queryOf(req)))
);
