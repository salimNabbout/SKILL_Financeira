import { createCashflowManualEntry } from "@/app/api/_lib/cashflow";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** POST /api/v1/fluxo-caixa/ajustes-manuais — cria um lançamento manual (201). */
export const POST = withAuth(async (req, { session, container }) =>
  json(await createCashflowManualEntry(container, session, await readJson(req)), 201)
);
