"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import type { Approval } from "@/core/entities";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import { errorMessage, fdOptional, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/aprovacoes";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function decideApprovalAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const approvalId = fdString(formData, "approvalId");
  const decision = fdString(formData, "decision");
  if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
    fail("Decisão inválida.");
  }

  let result: OrchestratorResponse | { approval: Approval };
  try {
    result = await orchestrator.decideApproval({
      companyId: session.company.id,
      approvalId,
      decision,
      actor: session.actor,
      justification: fdOptional(formData, "justification"),
    });
  } catch (error) {
    // PermissionError / SegregationError / ValidationError chegam aqui com
    // mensagem em pt-BR — exibidas no banner de erro.
    fail(errorMessage(error));
  }

  if ("flowRunId" in result) {
    ok(`Fluxo retomado: ${result.consolidated.summary}`);
  }
  ok(decision === "approved" ? "Aprovação concedida e registrada." : "Solicitação rejeitada e registrada.");
}
