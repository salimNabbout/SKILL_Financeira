import { NextResponse } from "next/server";
import { exportAccountingBatch } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";

export const runtime = "nodejs";

/**
 * POST /api/v1/accounting/export — { period: "YYYY-MM", layout?: padrao|dominio|omie|contmatic }.
 * Executa o fluxo accounting_export e devolve o ARQUIVO do lote (download).
 * Aceita JSON ou formulário (a tela Relatórios envia o form direto para cá).
 * Sem lançamentos pendentes: JSON devolve o envelope com count=0; formulário
 * volta para /relatorios com a mensagem.
 */
export const POST = withAuth(async (req, { session, container }) => {
  const contentType = req.headers.get("content-type") ?? "";
  const isForm = !contentType.includes("application/json");
  const input = isForm
    ? Object.fromEntries(
        [...(await req.formData()).entries()].filter(([, v]) => typeof v === "string" && v !== "")
      )
    : await readJson(req);

  try {
    const file = await exportAccountingBatch(container, session, input);
    if (file.count === 0) {
      const message = `Nenhum lançamento pendente de exportação no período ${file.period}.`;
      if (isForm) {
        return NextResponse.redirect(
          new URL(`/relatorios?erro=${encodeURIComponent(message)}`, req.url),
          303
        );
      }
      return NextResponse.json({ data: { ...file, message } });
    }
    return new Response(file.content, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForm) {
      const message = error instanceof Error ? error.message : "Falha na exportação contábil.";
      return NextResponse.redirect(
        new URL(`/relatorios?erro=${encodeURIComponent(message)}`, req.url),
        303
      );
    }
    throw error;
  }
});
