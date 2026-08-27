import { requireSession } from "@/lib/session";
import { buildErrorLogCsv, type ImportPreview } from "../../_lib/import-csv";

export const runtime = "nodejs";

/**
 * GET /contas-a-pagar/importar/erros?previa=<base64url>
 *
 * Baixa o log das linhas recusadas, com o motivo e o conteúdo original de cada
 * uma — para o usuário corrigir a planilha de origem em vez de caçar o erro.
 * A prévia vem da própria URL: nada foi persistido.
 */
export async function GET(req: Request): Promise<Response> {
  await requireSession();
  const bruto = new URL(req.url).searchParams.get("previa");
  if (!bruto) return new Response("Pré-visualização não informada.", { status: 400 });

  let previa: ImportPreview;
  try {
    previa = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as ImportPreview;
  } catch {
    return new Response("Pré-visualização inválida.", { status: 400 });
  }

  const hoje = new Date().toISOString().slice(0, 10);
  return new Response(buildErrorLogCsv(previa.erros ?? []), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="erros-importacao_${hoje}.csv"`,
    },
  });
}
