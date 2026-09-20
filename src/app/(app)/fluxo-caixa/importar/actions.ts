"use server";

import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { errorMessage } from "@/app/(app)/cadastros/_lib/form-utils";
import {
  MAX_CASHFLOW_IMPORT_BYTES,
  applyCashflowImport,
  parseCashflowImport,
  type CashflowImportReport,
} from "@/app/api/_lib/cashflow";

const BASE = "/fluxo-caixa";

export interface AnaliseState {
  report?: CashflowImportReport;
  erro?: string;
}

/**
 * Etapa 1 — analisa a planilha e devolve o relatório linha a linha ao
 * formulário (useActionState). NÃO grava nada.
 */
export async function analisarPlanilhaAction(_prev: AnaliseState, formData: FormData): Promise<AnaliseState> {
  const session = await requireSession();
  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size === 0) return { erro: "Selecione um arquivo .xlsx." };
  if (!/\.xlsx$/i.test(arquivo.name)) return { erro: "O arquivo precisa ser .xlsx (a planilha exportada pelo app, sem macros)." };
  if (arquivo.size > MAX_CASHFLOW_IMPORT_BYTES) return { erro: "Arquivo acima de 8 MB." };
  try {
    const container = await getContainer();
    const report = await parseCashflowImport(container, session, {
      fileName: arquivo.name,
      bytes: new Uint8Array(await arquivo.arrayBuffer()),
    });
    return { report };
  } catch (error) {
    return { erro: errorMessage(error) };
  }
}

/**
 * Etapa 2 — grava as linhas validadas (tudo-ou-nada, transacional, auditado).
 * A prévia volta no próprio formulário (campo oculto): nenhum estado no servidor.
 */
export async function confirmarImportacaoAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const ano = String(formData.get("ano") ?? "").trim();
  const back = `${BASE}/importar${ano ? `?ano=${encodeURIComponent(ano)}` : ""}`;
  const bruto = String(formData.get("payload") ?? "");
  let payload: { fileName: string; rows: unknown[] };
  try {
    payload = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as { fileName: string; rows: unknown[] };
  } catch {
    redirect(`${back}${back.includes("?") ? "&" : "?"}erro=${encodeURIComponent("Não consegui ler a pré-visualização. Refaça o envio do arquivo.")}`);
  }

  let result: CashflowImportReport;
  try {
    const container = await getContainer();
    result = await applyCashflowImport(container, session, payload);
  } catch (error) {
    redirect(`${back}${back.includes("?") ? "&" : "?"}erro=${encodeURIComponent(errorMessage(error))}`);
  }
  if (result.resultado === "rejeitado") {
    const motivos = result.erros.slice(0, 3).map((e) => `linha ${e.linha}: ${e.motivo}`).join(" | ");
    redirect(`${back}${back.includes("?") ? "&" : "?"}erro=${encodeURIComponent(`Importação rejeitada — ${motivos}`)}`);
  }
  const msg = `Planilha "${result.arquivo}": ${result.criadas} ajuste(s) manual(is) criado(s)${result.ignoradas.length > 0 ? `, ${result.ignoradas.length} linha(s) ignorada(s) por já existir` : ""}.`;
  redirect(`${BASE}/lancamentos?${ano ? `ano=${encodeURIComponent(ano)}&` : ""}ok=${encodeURIComponent(msg)}`);
}
