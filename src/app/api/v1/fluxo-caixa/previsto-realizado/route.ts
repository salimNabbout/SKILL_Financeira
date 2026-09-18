import { getCashflowVariance } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/previsto-realizado?ano= — previsto, realizado e variação por totais e grupos. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getCashflowVariance(container, session, queryOf(req)))
);
