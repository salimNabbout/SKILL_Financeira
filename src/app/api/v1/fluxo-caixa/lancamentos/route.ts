import { listCashflowEntries } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/lancamentos?ano=&mes=&categoria=&status=&centro_custo=&origem=&offset=&limit= — paginado, com totais do conjunto. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listCashflowEntries(container, session, queryOf(req)))
);
