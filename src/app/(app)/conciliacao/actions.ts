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

export async function syncBankAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const bankAccountId = fdString(formData, "bankAccountId");
  if (!bankAccountId) {
    fail("Selecione a conta bancária.");
  }
  const sinceDaysRaw = fdOptional(formData, "sinceDays");
  const sinceDays = sinceDaysRaw ? Number(sinceDaysRaw) : undefined;
  if (sinceDays !== undefined && (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 90)) {
    fail("Período inválido: informe entre 1 e 90 dias.");
  }

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "bank_sync",
      companyId: session.company.id,
      actor: session.actor,
      payload: { bankAccountId, sinceDays },
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  if (response.status === "failed") fail(flowErrorMessage(response));

  const sync = response.results.find((r) => r.stepId === "sync")?.result?.data as
    | { provider?: string; imported?: number; duplicates?: number }
    | null
    | undefined;
  const match = response.results.find((r) => r.stepId === "match")?.result?.data as
    | { autoConfirmed?: number; suggested?: number; unmatched?: number }
    | null
    | undefined;

  ok(
    `Sincronização via provedor "${sync?.provider ?? "mock"}" (dados sintéticos — nenhum banco real consultado): ` +
      `${sync?.imported ?? 0} nova(s), ${sync?.duplicates ?? 0} já existente(s) ignorada(s). ` +
      `Conciliação automática: ${match?.autoConfirmed ?? 0} baixada(s), ${match?.suggested ?? 0} sugestão(ões) para revisão, ${match?.unmatched ?? 0} sem correspondência.` +
      (response.idempotent_replay ? " (requisição repetida — nada foi reprocessado)" : "")
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

/**
 * CONCILIA um pagamento aprovado: grava a data real da saída do dinheiro e
 * devolve o título para Contas a pagar já quitado ("Pago" até o vencimento,
 * "Pago Atrasado" depois dele). As regras ficam na skill contas_a_pagar; aqui
 * só validamos a entrada e traduzimos o erro.
 *
 * A caixa de confirmação é `required` no HTML, mas a conferimos também no
 * servidor: sem ela, um POST direto passaria por cima da confirmação humana.
 */
export async function reconcilePaymentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const paymentId = fdString(formData, "paymentId");
  const paymentDate = fdString(formData, "paymentDate");
  const confirmado = fdOptional(formData, "confirmado") === "on";

  if (!paymentId) fail("Pagamento não identificado para conciliação.");
  if (!paymentDate) fail("Informe a data do pagamento.");
  if (!confirmado) fail("Marque a caixa de confirmação para registrar a conciliação.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "reconcile_payment",
      companyId: session.company.id,
      actor: session.actor,
      payload: { paymentId, paymentDate },
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  if (response.status === "failed") fail(flowErrorMessage(response));

  ok("Conciliação registrada. O título voltou para Contas a pagar já quitado.");
}

/**
 * Corrige a DATA DE PAGAMENTO de um lançamento do card "Conciliados". Só esse
 * campo — as regras e os bloqueios ficam na skill, e o fluxo realinha o
 * lançamento contábil junto. Em falha, reabre o formulário na mesma linha
 * preservando o que foi digitado.
 */
export async function adjustPaymentDateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const paymentId = fdString(formData, "paymentId");
  const paymentDate = fdString(formData, "paymentDate");

  function failEdit(message: string): never {
    const qs = new URLSearchParams({ editar: paymentId, erro: message });
    if (paymentDate) qs.set("f_pagamento", paymentDate);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!paymentId) fail("Pagamento não identificado.");
  if (!paymentDate) failEdit("Informe a data do pagamento.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "adjust_payment_date",
      companyId: session.company.id,
      actor: session.actor,
      payload: { paymentId, paymentDate },
    });
  } catch (error) {
    failEdit(errorMessage(error));
  }

  if (response.status === "failed") failEdit(flowErrorMessage(response));

  ok("Data do pagamento corrigida. A situação do título foi reclassificada em Contas a pagar.");
}

/**
 * DESFAZ a conciliação de um pagamento: estorna o pagamento (o título volta
 * para Contas a pagar com o status da regra existente), estorna o lançamento
 * contábil e marca a aprovação de origem como estornada — ela sai do histórico
 * de decisões sem ser apagada. Em falha, reabre o pop-up com o motivo.
 */
export async function undoReconciliationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const paymentId = fdString(formData, "paymentId");
  const reason = fdString(formData, "reason");

  function failUndo(message: string): never {
    const qs = new URLSearchParams({ excluir: paymentId, erro: message });
    if (reason) qs.set("f_motivo", reason);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!paymentId) fail("Pagamento não identificado.");
  // Motivo obrigatório: é o que explica a exclusão na trilha de auditoria.
  if (!reason) failUndo("Informe o motivo da exclusão.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "undo_reconciliation",
      companyId: session.company.id,
      actor: session.actor,
      payload: { paymentId, reason },
    });
  } catch (error) {
    failUndo(errorMessage(error));
  }

  if (response.status === "failed") failUndo(flowErrorMessage(response));

  ok("Conciliação desfeita. O título voltou para Contas a pagar.");
}
