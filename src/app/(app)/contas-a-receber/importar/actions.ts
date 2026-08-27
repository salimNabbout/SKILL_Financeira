"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { assertPermission } from "@/core/auth";
import { errorMessage } from "@/app/(app)/cadastros/_lib/form-utils";
import { MAX_STATEMENT_FILE_BYTES, decodeStatementBuffer } from "@/lib/importers/decode";
import { validateImportCsv, type ImportRowValid } from "../_lib/import-csv";
import { callSkill } from "../_lib/call-skill";
import { carregarContextoImportacao } from "./_lib/contexto";

const PATH = "/contas-a-receber/importar";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

/**
 * Etapa 1 — analisa o arquivo e devolve a pré-visualização.
 *
 * NÃO grava nada: só valida. O resultado volta para a mesma página, que exibe
 * linha a linha o que passou, o que falhou e por quê.
 */
export async function analisarCsvAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    assertPermission(session.actor, "receivable.create");
  } catch (error) {
    fail(errorMessage(error));
  }

  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    fail("Selecione um arquivo CSV.");
  }
  if (!/\.csv$/i.test(arquivo.name)) {
    fail("O arquivo precisa ser .csv.");
  }
  if (arquivo.size > MAX_STATEMENT_FILE_BYTES) {
    fail("Arquivo acima de 2 MB. Divida a planilha e importe em partes.");
  }

  let previa: ReturnType<typeof validateImportCsv>;
  try {
    // Mesmo decodificador dos extratos: UTF-8 estrito com fallback
    // Windows-1252, que é o que sai do Excel brasileiro.
    const { content: conteudo } = decodeStatementBuffer(
      new Uint8Array(await arquivo.arrayBuffer())
    );
    const container = await getContainer();
    const ctx = await carregarContextoImportacao(container.repos, session.company.id);
    previa = validateImportCsv(conteudo, ctx);
  } catch (error) {
    fail(errorMessage(error));
  }

  if (previa.validas.length === 0 && previa.erros.length === 0) {
    fail("O arquivo não tem nenhuma linha de dados.");
  }

  // A prévia trafega no próprio formulário da confirmação (campo oculto), sem
  // estado no servidor: nada é persistido enquanto o usuário não confirmar.
  const payload = Buffer.from(JSON.stringify(previa), "utf8").toString("base64url");
  redirect(`${PATH}?previa=${payload}`);
}

/**
 * Etapa 2 — grava as linhas confirmadas.
 *
 * Cada título passa pela skill `contas_a_receber`, a mesma do lançamento
 * manual: validações de domínio, auditoria e idempotência por chave natural
 * continuam valendo — a importação não é um atalho por baixo do app.
 */
export async function confirmarImportacaoAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    assertPermission(session.actor, "receivable.create");
  } catch (error) {
    fail(errorMessage(error));
  }

  const bruto = String(formData.get("linhas") ?? "");
  const incluirDuplicadas = formData.get("incluirDuplicadas") === "on";
  if (!bruto) fail("Nada para importar — refaça o envio do arquivo.");

  let linhas: ImportRowValid[];
  try {
    linhas = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as ImportRowValid[];
  } catch {
    fail("Não consegui ler a pré-visualização. Refaça o envio do arquivo.");
  }

  const selecionadas = linhas.filter((l) => incluirDuplicadas || !l.duplicado);
  const ignoradas = linhas.length - selecionadas.length;

  let importados = 0;
  const falhas: string[] = [];

  for (const linha of selecionadas) {
    try {
      const resultado = await callSkill(session, "contas_a_receber", {
        action: "create_receivable",
        customerId: linha.customerId,
        description: linha.description,
        issueDate: linha.issueDate,
        dueDate: linha.dueDate,
        amountCents: linha.amountCents,
        installmentCount: linha.installmentCount,
        ...(linha.categoryId ? { categoryId: linha.categoryId } : {}),
        ...(linha.costCenterId ? { costCenterId: linha.costCenterId } : {}),
      });
      if (resultado.status === "error") {
        falhas.push(`Linha ${linha.linha}: ${resultado.alerts?.[0]?.message ?? "recusado."}`);
      } else {
        importados += 1;
      }
    } catch (error) {
      falhas.push(`Linha ${linha.linha}: ${errorMessage(error)}`);
    }
  }

  revalidatePath("/contas-a-receber");
  const resumo = new URLSearchParams({
    importados: String(importados),
    ignorados: String(ignoradas),
    falhas: String(falhas.length),
  });
  if (falhas.length > 0) resumo.set("detalhe", falhas.slice(0, 5).join(" | "));
  redirect(`${PATH}?${resumo.toString()}`);
}
