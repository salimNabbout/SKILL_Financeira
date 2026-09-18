import { getCashflowPending } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/pendencias?ano= — lançamentos em a_classificar, agrupados pela chave sugerida. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getCashflowPending(container, session, queryOf(req)))
);
