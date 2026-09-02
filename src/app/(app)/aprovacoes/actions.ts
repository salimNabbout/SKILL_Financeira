"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import type { Approval } from "@/core/entities";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import {
  errorMessage,
  fdOptional,
  fdString,
  flowErrorMessage,
} from "@/app/(app)/cadastros/_lib/form-utils";

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

/**
 * ESTORNO de um pagamento já executado, a partir do histórico de Aprovações.
 * Desfaz a baixa e devolve o título para Contas a pagar (a regra e os bloqueios
 * ficam na skill contas_a_pagar; aqui só validamos a entrada e traduzimos o
 * erro). Em falha, reabre o pop-up de confirmação preservando o motivo digitado.
 */
export async function reversePaymentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const paymentId = fdString(formData, "paymentId");
  const reason = fdString(formData, "reason");

  function failReverse(message: string): never {
    const qs = new URLSearchParams({ estornar: paymentId, erro: message });
    if (reason) qs.set("f_motivo", reason);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!paymentId) fail("Pagamento não identificado para estorno.");
  // Motivo obrigatório: é o que explica o estorno na trilha de auditoria.
  if (!reason) failReverse("Informe o motivo do estorno.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "reverse_payment",
      companyId: session.company.id,
      actor: session.actor,
      payload: { paymentId, reason },
    });
  } catch (error) {
    failReverse(errorMessage(error));
  }

  if (response.status === "failed") failReverse(flowErrorMessage(response));

  ok("Pagamento estornado. O título voltou para Contas a pagar.");
}
