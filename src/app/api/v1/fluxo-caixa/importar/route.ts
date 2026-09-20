import { MAX_CASHFLOW_IMPORT_BYTES, importCashflowWorkbook } from "@/app/api/_lib/cashflow";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";
import { ValidationError } from "@/core/errors";

export const runtime = "nodejs";

/**
 * POST /api/v1/fluxo-caixa/importar[?simular=1] — multipart/form-data, campo `arquivo` (.xlsx).
 *
 * Lê a aba "Lançamentos", valida TODAS as linhas e devolve o relatório linha a
 * linha. Tudo-ou-nada: qualquer erro → 422 e nada é gravado. Sem erros, cria
 * um ajuste manual (fc_ajuste_manual) por linha NOVA, com a observação
 * "importação planilha <arquivo>"; linhas com origem do app ou já existentes
 * são ignoradas (sem dupla contagem). `simular=1` só valida.
 */
export const POST = withAuth(async (req, { session, container }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ValidationError('Envie multipart/form-data com o campo "arquivo" (.xlsx).');
  }
  const file = form.get("arquivo");
  if (!(file instanceof File) || file.size === 0) throw new ValidationError('Campo "arquivo" ausente ou vazio.');
  if (!/\.xlsx$/i.test(file.name)) throw new ValidationError("O arquivo precisa ser .xlsx (sem macros).");
  if (file.size > MAX_CASHFLOW_IMPORT_BYTES) throw new ValidationError("Arquivo acima de 8 MB.");

  const report = await importCashflowWorkbook(container, session, {
    fileName: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    simulate: queryOf(req).simular === "1",
  });
  return json(report, report.resultado === "rejeitado" ? 422 : 200);
});
