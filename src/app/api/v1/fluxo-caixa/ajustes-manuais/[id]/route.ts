import { deleteCashflowManualEntry, updateCashflowManualEntry } from "@/app/api/_lib/cashflow";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** PUT /api/v1/fluxo-caixa/ajustes-manuais/:id — altera (409 se a versão estiver defasada). */
export const PUT = withAuth<{ id: string }>(async (req, { session, container, params }) =>
  json(await updateCashflowManualEntry(container, session, params.id, await readJson(req)))
);

/** DELETE /api/v1/fluxo-caixa/ajustes-manuais/:id — exclui, guardando o valor anterior na auditoria. */
export const DELETE = withAuth<{ id: string }>(async (_req, { session, container, params }) =>
  json(await deleteCashflowManualEntry(container, session, params.id))
);
