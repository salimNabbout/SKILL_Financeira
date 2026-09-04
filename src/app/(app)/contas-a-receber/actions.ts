"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import { assertPermission } from "@/core/auth";
import type { Receivable } from "@/core/entities";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import type { SkillResult } from "@/core/types";
import {
  errorMessage,
  fdOptional,
  fdString,
  flowErrorMessage,
  parseBRLToCents,
  skillErrorMessage,
} from "@/app/(app)/cadastros/_lib/form-utils";
import { callSkill } from "./_lib/call-skill";

const PATH = "/contas-a-receber";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

// Descrição pode ser longa; ao PROPAGAR na URL truncamos para não estourar o
// limite de tamanho. Truncagem só na propagação — nunca no que seria salvo.
const MAX_URL_DESCRIPTION = 200;

export async function createReceivableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { repos } = await getContainer();

  // O campo Cliente é um autocompletar nativo (<input list>) que submete o
  // NOME; resolvemos nome → id abaixo (nomes são únicos por empresa).
  const customerName = fdString(formData, "customerName");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  const amountRaw = fdString(formData, "amount");
  const installmentRaw = fdOptional(formData, "installmentCount");
  const categoryId = fdOptional(formData, "categoryId");
  const costCenterId = fdOptional(formData, "costCenterId");
  const method = fdOptional(formData, "method");
  const notes = fdOptional(formData, "notes");

  // Falha na CRIAÇÃO: reexibe o Card "Novo título" com TUDO que foi digitado
  // (searchParams nt_* → defaultValue), inclusive o campo errado. Preserva o
  // NOME digitado do cliente (não o id — pode não ter resolvido).
  function failCreate(message: string): never {
    const qs = new URLSearchParams({ erro: message });
    if (/Verificar a Data da Emissão/i.test(message)) qs.set("nt_erro", "data");
    if (customerName) qs.set("nt_cliente", customerName);
    if (description) qs.set("nt_descricao", description.slice(0, MAX_URL_DESCRIPTION));
    if (amountRaw) qs.set("nt_valor", amountRaw);
    if (issueDate) qs.set("nt_emissao", issueDate);
    if (dueDate) qs.set("nt_vencimento", dueDate);
    if (installmentRaw) qs.set("nt_parcelas", installmentRaw);
    if (categoryId) qs.set("nt_categoria", categoryId);
    if (costCenterId) qs.set("nt_centrocusto", costCenterId);
    if (method) qs.set("nt_metodo", method);
    if (notes) qs.set("nt_observacao", notes.slice(0, MAX_URL_DESCRIPTION));
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!customerName || !description || !issueDate || !dueDate) {
    failCreate("Preencha cliente, descrição, emissão e vencimento.");
  }

  // Resolve nome → id: case-insensitive, ignorando espaços nas pontas. NUNCA
  // escolhe o primeiro em caso de ambiguidade.
  const wanted = customerName.trim().toLowerCase();
  const matches = (await repos.customers.listAll(session.company.id)).filter(
    (c) => c.active && c.name.trim().toLowerCase() === wanted
  );
  if (matches.length === 0) {
    failCreate("Cliente não encontrado. Selecione um da lista.");
  }
  if (matches.length > 1) {
    failCreate(
      `Há mais de um cliente com o nome "${customerName.trim()}". Ajuste o cadastro para diferenciá-los antes de lançar o título.`
    );
  }
  const customerId = matches[0].id;

  let amountCents = 0;
  let installmentCount = 1;
  try {
    assertPermission(session.actor, "receivable.create");
    amountCents = parseBRLToCents(amountRaw);
    installmentCount = Number(installmentRaw ?? "1");
  } catch (error) {
    failCreate(errorMessage(error));
  }
  if (amountCents <= 0) failCreate("O valor do título deve ser positivo.");
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 120) {
    failCreate("Número de parcelas inválido (1 a 120).");
  }

  let result: SkillResult<unknown>;
  try {
    result = await callSkill(session, "contas_a_receber", {
      action: "create_receivable",
      customerId,
      description,
      issueDate,
      dueDate,
      amountCents,
      categoryId,
      // Centro de custo é opcional: só entra quando selecionado (fdOptional já
      // devolve undefined se vazio; não enviar a chave vazia).
      ...(costCenterId ? { costCenterId } : {}),
      installmentCount,
      method,
      // Observação é opcional: só entra quando preenchida.
      ...(notes ? { notes } : {}),
    });
  } catch (error) {
    failCreate(errorMessage(error));
  }

  if (result.status === "error") failCreate(skillErrorMessage(result));
  const receivables = (result.data as { receivables?: Receivable[] } | null)?.receivables ?? [];
  ok(`Título criado: ${receivables.length} parcela(s) somando ${formatBRL(amountCents)}.`);
}

export async function issueChargeAction(formData: FormData): Promise<void> {
  const session = await requireSession();

  const receivableId = fdString(formData, "receivableId");
  const kind = fdString(formData, "kind");
  if (!receivableId || (kind !== "pix" && kind !== "boleto")) {
    fail("Selecione o título e o tipo de cobrança (Pix ou boleto).");
  }

  let result: SkillResult<unknown>;
  try {
    assertPermission(session.actor, "receivable.create");
    result = await callSkill(session, "contas_a_receber", {
      action: "issue_charge",
      receivableId,
      kind,
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  if (result.status === "error") fail(skillErrorMessage(result));
  const charge = (result.data as {
    charge?: { provider?: string; chargeId?: string; code?: string };
  } | null)?.charge;
  const code = charge?.code ?? "";
  const preview = code.length > 60 ? `${code.slice(0, 60)}…` : code;
  ok(
    `Cobrança ${kind} gerada via provedor "${charge?.provider ?? "mock"}" (código fake — nada registrado em PSP/banco). ` +
      `Código: ${preview} (íntegra anotada no título).`
  );
}

export async function registerReceiptAction(formData: FormData): Promise<void> {
  const session = await requireSession();

  const receivableId = fdString(formData, "receivableId");
  const receivedDate = fdString(formData, "receivedDate");
  const method = fdString(formData, "method");
  const amountRaw = fdString(formData, "amount");
  const bankAccountId = fdOptional(formData, "bankAccountId");

  // Falha no RECEBIMENTO: reabre o form inline na MESMA linha (rc_id) preservando
  // o que foi digitado (rc_* → defaultValue). Sucesso não propaga.
  function failReceipt(message: string): never {
    const qs = new URLSearchParams({ erro: message, rc_id: receivableId });
    if (amountRaw) qs.set("rc_valor", amountRaw);
    if (receivedDate) qs.set("rc_data", receivedDate);
    if (method) qs.set("rc_metodo", method);
    if (bankAccountId) qs.set("rc_conta", bankAccountId);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!receivableId) fail("Título não identificado para recebimento.");
  if (!receivedDate || !method) {
    failReceipt("Preencha valor, data e método do recebimento.");
  }

  let amountCents = 0;
  try {
    assertPermission(session.actor, "receivable.settle");
    amountCents = parseBRLToCents(amountRaw);
  } catch (error) {
    failReceipt(errorMessage(error));
  }
  if (amountCents <= 0) failReceipt("O valor recebido deve ser positivo.");

  let result: SkillResult<unknown>;
  try {
    result = await callSkill(session, "contas_a_receber", {
      action: "register_receipt",
      receivableId,
      amountCents,
      receivedDate,
      method,
      bankAccountId,
    });
  } catch (error) {
    failReceipt(errorMessage(error));
  }

  if (result.status === "error") failReceipt(skillErrorMessage(result));
  const remaining = (result.data as { remainingCents?: number } | null)?.remainingCents;
  ok(
    `Recebimento de ${formatBRL(amountCents)} registrado.` +
      (remaining !== undefined ? ` Saldo restante: ${formatBRL(remaining)}.` : "")
  );
}

export async function cancelReceivableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const receivableId = fdString(formData, "receivableId");
  const reason = fdString(formData, "reason");

  // Reabre o form inline de exclusão na mesma linha, preservando o motivo.
  function failCancel(message: string): never {
    const qs = new URLSearchParams({ excluir: receivableId, erro: message });
    if (reason) qs.set("f_motivo", reason);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!receivableId) fail("Título não identificado para cancelamento.");
  // reason é obrigatório na skill; exigimos aqui para dar mensagem clara e não
  // inventar texto padrão (que esvaziaria a auditoria).
  if (!reason) failCancel("Informe o motivo do cancelamento.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "cancel_receivable",
      companyId: session.company.id,
      actor: session.actor,
      payload: { receivableId, reason },
    });
  } catch (error) {
    failCancel(errorMessage(error));
  }

  if (response.status === "failed") failCancel(flowErrorMessage(response));

  ok("Título cancelado e mantido no histórico para auditoria.");
}

/**
 * EDIÇÃO de título a receber. As regras e os bloqueios ficam na skill
 * (recusa título recebido, cancelado ou com recebimento registrado); aqui só
 * validamos a entrada e, em falha, reabrimos o formulário na mesma linha
 * preservando o que foi digitado.
 */
export async function updateReceivableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const receivableId = fdString(formData, "receivableId");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  const amountRaw = fdString(formData, "amount");
  const categoryId = fdOptional(formData, "categoryId");
  const costCenterId = fdOptional(formData, "costCenterId");
  const notes = fdOptional(formData, "notes");

  function failEdit(message: string): never {
    const qs = new URLSearchParams({ editar: receivableId, erro: message });
    if (description) qs.set("f_descricao", description.slice(0, MAX_URL_DESCRIPTION));
    if (issueDate) qs.set("f_emissao", issueDate);
    if (dueDate) qs.set("f_vencimento", dueDate);
    if (amountRaw) qs.set("f_valor", amountRaw);
    if (categoryId) qs.set("f_categoria", categoryId);
    if (costCenterId) qs.set("f_centrocusto", costCenterId);
    if (notes) qs.set("f_notas", notes.slice(0, MAX_URL_DESCRIPTION));
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!receivableId) fail("Título não identificado para edição.");
  if (!description || !issueDate || !dueDate) {
    failEdit("Preencha descrição, emissão e vencimento.");
  }

  let amountCents = 0;
  try {
    amountCents = parseBRLToCents(amountRaw);
  } catch (error) {
    failEdit(errorMessage(error));
  }
  if (amountCents <= 0) failEdit("O valor do título deve ser positivo.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "update_receivable",
      companyId: session.company.id,
      actor: session.actor,
      payload: {
        receivableId,
        description,
        issueDate,
        dueDate,
        amountCents,
        // Vazio vira undefined e MANTÉM o atual — a skill só limpa com null.
        categoryId,
        costCenterId,
        notes,
      },
    });
  } catch (error) {
    failEdit(errorMessage(error));
  }

  if (response.status === "failed") failEdit(flowErrorMessage(response));

  ok("Título atualizado.");
}

/**
 * ESTORNO de um recebimento: devolve o saldo e o título volta para a fila.
 * Em falha, reabre o pop-up preservando o motivo.
 */
export async function reverseReceiptAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const receiptId = fdString(formData, "receiptId");
  const reason = fdString(formData, "reason");

  function failReverse(message: string): never {
    const qs = new URLSearchParams({ estornar: receiptId, erro: message });
    if (reason) qs.set("f_motivo_estorno", reason);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!receiptId) fail("Recebimento não identificado.");
  // Motivo obrigatório: é o que explica o estorno na trilha de auditoria.
  if (!reason) failReverse("Informe o motivo do estorno.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "reverse_receipt",
      companyId: session.company.id,
      actor: session.actor,
      payload: { receiptId, reason },
    });
  } catch (error) {
    failReverse(errorMessage(error));
  }

  if (response.status === "failed") failReverse(flowErrorMessage(response));

  ok("Recebimento estornado. O saldo voltou para o título.");
}

/** Corrige a DATA de um recebimento já registrado. */
export async function adjustReceiptDateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const receiptId = fdString(formData, "receiptId");
  const receivableId = fdString(formData, "receivableId");
  const receivedDate = fdString(formData, "receivedDate");

  function failAdjust(message: string): never {
    const qs = new URLSearchParams({ recebimentos: receivableId, erro: message });
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!receiptId) fail("Recebimento não identificado.");
  if (!receivedDate) failAdjust("Informe a data do recebimento.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "adjust_receipt_date",
      companyId: session.company.id,
      actor: session.actor,
      payload: { receiptId, receivedDate },
    });
  } catch (error) {
    failAdjust(errorMessage(error));
  }

  if (response.status === "failed") failAdjust(flowErrorMessage(response));

  ok("Data do recebimento corrigida. A situação do título foi reclassificada.");
}
