import { importStatement } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * POST /api/v1/import/statement — { bankAccountId, format: "ofx"|"csv", content }.
 * Atalho para o fluxo bank_statement_import do orquestrador. Aceita APENAS JSON
 * com o conteúdo do arquivo como string em `content` (multipart não suportado
 * no MVP — o cliente lê o arquivo e envia o texto).
 */
export const POST = withAuth(async (req, { session, container }) =>
  json(await importStatement(container, session, await readJson(req)))
);
