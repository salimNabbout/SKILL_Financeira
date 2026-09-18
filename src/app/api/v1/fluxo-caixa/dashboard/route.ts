import { getCashflowDashboard } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/dashboard?ano= — KPIs, séries dos gráficos e alertas. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getCashflowDashboard(container, session, queryOf(req)))
);
