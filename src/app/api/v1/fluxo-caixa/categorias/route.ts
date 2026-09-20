import { listCashflowCategories } from "@/app/api/_lib/cashflow";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/fluxo-caixa/categorias — plano de 37 categorias da planilha (+ transferencia_interna). */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listCashflowCategories(container, session))
);
