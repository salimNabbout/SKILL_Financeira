import { importStatement } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";
import { extractStatementUpload } from "@/lib/importers";
import { ValidationError } from "@/core/errors";

export const runtime = "nodejs";

/**
 * POST /api/v1/import/statement — atalho para o fluxo bank_statement_import.
 *
 * Aceita dois corpos:
 * - multipart/form-data: campos `bankAccountId`, `format` (auto|ofx|csv, default
 *   auto) e o arquivo em `arquivo` (ou `file`); campo `content` como fallback de
 *   texto colado. Codificação UTF-8 com fallback ISO-8859-1/Windows-1252.
 * - application/json: { bankAccountId, format: "ofx"|"csv", content } (modo
 *   original — o cliente lê o arquivo e envia o texto).
 */
export const POST = withAuth(async (req, { session, container }) => {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData().catch(() => {
      throw new ValidationError("Corpo multipart inválido.");
    });
    const bankAccountId = String(formData.get("bankAccountId") ?? "");
    const upload = await extractStatementUpload(formData);
    return json(
      await importStatement(container, session, {
        bankAccountId,
        format: upload.format,
        content: upload.content,
      })
    );
  }
  return json(await importStatement(container, session, await readJson(req)));
});
