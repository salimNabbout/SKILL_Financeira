import { recalculateCashflow } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** POST /api/v1/fluxo-caixa/recalcular?ano= — recomputa a unificação e devolve atualizadoEm e contagens. */
export const POST = withAuth(async (req, { session, container }) =>
  json(await recalculateCashflow(container, session, queryOf(req)))
);
