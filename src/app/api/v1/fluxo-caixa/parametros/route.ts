import { getCashflowParameters, putCashflowParameters } from "@/app/api/_lib/cashflow";
import { queryOf, readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/parametros?ano=2026 — parâmetros do exercício + cenários (padrões quando não gravados). */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getCashflowParameters(container, session, queryOf(req)))
);

/** PUT /api/v1/fluxo-caixa/parametros — grava saldo inicial, reserva, override e (opcional) cenários; 409 se a versão estiver defasada. */
export const PUT = withAuth(async (req, { session, container }) =>
  json(await putCashflowParameters(container, session, await readJson(req)))
);
