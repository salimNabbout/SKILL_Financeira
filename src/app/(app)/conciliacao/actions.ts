"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import type { SkillResult } from "@/core/types";
import { extractStatementUpload } from "@/lib/importers";
import { callSkill } from "@/app/(app)/contas-a-receber/_lib/call-skill";
import {
  errorMessage,
  fdOptional,
  fdString,
  flowErrorMessage,
  skillErrorMessage,
} from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/conciliacao";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function importStatementAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const bankAccountId = fdString(formData, "bankAccountId");
  if (!bankAccountId) {
    fail("Selecione a conta bancária.");
  }

  let response: OrchestratorResponse;
  let encodingNote = "";
  try {
    // Arquivo enviado tem precedência; texto colado é o fallback. Formato "auto"
    // detecta por assinatura OFX/extensão; encoding UTF-8 com fallback Windows-1252.
    const upload = await extractStatementUpload(formData);
    if (upload.encoding === "windows-1252") {
      encodingNote = " Arquivo decodificado como ISO-8859-1/Windows-1252.";
    }
    response = await orchestrator.execute({
      flow: "bank_statement_import",
      companyId: session.company.id,
      actor: session.actor,
      payload: { bankAccountId, format: upload.format, content: upload.content },
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  if (response.status === "failed") fail(flowErrorMessage(response));

  const imp = response.results.find((r) => r.stepId === "import")?.result?.data as
    | { imported?: number; duplicates?: number }
    | null
    | undefined;
  const match = response.results.find((r) => r.stepId === "match")?.result?.data as
    | { autoConfirmed?: number; suggested?: number; unmatched?: number }
    | null
    | undefined;

  ok(
    `Importação concluída: ${imp?.imported ?? 0} nova(s), ${imp?.duplicates ?? 0} duplicada(s) ignorada(s). ` +
      `Conciliação automática: ${match?.autoConfirmed ?? 0} baixada(s), ${match?.suggested ?? 0} sugestão(ões) para revisão, ${match?.unmatched ?? 0} sem correspondência.` +
      (response.idempotent_replay ? " (requisição repetida — nada foi reprocessado)" : "") +
      encodingNote
  );
}

export async function confirmMatchAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const matchId = fdString(formData, "matchId");
  if (!matchId) fail("Sugestão inválida.");

  let result: SkillResult<unknown>;
  try {
    result = await callSkill(session, "conciliacao_bancaria", {
      action: "confirm_match",
      matchId,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  if (result.status === "error") fail(skillErrorMessage(result));
  ok("Conciliação confirmada e baixa aplicada.");
}

export async function rejectMatchAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const matchId = fdString(formData, "matchId");
  if (!matchId) fail("Sugestão inválida.");

  let result: SkillResult<unknown>;
  try {
    result = await callSkill(session, "conciliacao_bancaria", {
      action: "reject_match",
      matchId,
      notes: fdOptional(formData, "notes"),
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  if (result.status === "error") fail(skillErrorMessage(result));
  ok("Sugestão rejeitada — a transação volta a ficar disponível para novas rodadas.");
}
