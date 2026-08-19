import { issueReceivableCharge } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * POST /api/v1/receivables/:id/charge — { kind: "pix" | "boleto" }.
 * Gera código de cobrança para o saldo em aberto via a porta ChargeProvider
 * (provedor MOCK no MVP: código fake, nada registrado em PSP/banco).
 */
export const POST = withAuth<{ id: string }>(async (req, { session, container, params }) =>
  json(await issueReceivableCharge(container, session, params.id, await readJson(req)))
);
