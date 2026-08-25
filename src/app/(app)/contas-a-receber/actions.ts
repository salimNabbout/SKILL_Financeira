"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import { assertPermission } from "@/core/auth";
import type { Receivable } from "@/core/entities";
import type { SkillResult } from "@/core/types";
import {
  errorMessage,
  fdOptional,
  fdString,
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

  const customerId = fdString(formData, "customerId");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  const amountRaw = fdString(formData, "amount");
  const installmentRaw = fdOptional(formData, "installmentCount");
  const categoryId = fdOptional(formData, "categoryId");
  const method = fdOptional(formData, "method");

  // Falha na CRIAÇÃO: reexibe o Card "Novo título" com TUDO que foi digitado
  // (searchParams nt_* → defaultValue), inclusive o campo errado. Marca
  // nt_erro=data quando a validação é de datas, para a page destacar Emissão/
  // Vencimento e dar autoFocus no Vencimento.
  function failCreate(message: string): never {
    const qs = new URLSearchParams({ erro: message });
    if (/Verificar a Data da Emissão/i.test(message)) qs.set("nt_erro", "data");
    if (customerId) qs.set("nt_cliente", customerId);
    if (description) qs.set("nt_descricao", description.slice(0, MAX_URL_DESCRIPTION));
    if (amountRaw) qs.set("nt_valor", amountRaw);
    if (issueDate) qs.set("nt_emissao", issueDate);
    if (dueDate) qs.set("nt_vencimento", dueDate);
    if (installmentRaw) qs.set("nt_parcelas", installmentRaw);
    if (categoryId) qs.set("nt_categoria", categoryId);
    if (method) qs.set("nt_metodo", method);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!customerId || !description || !issueDate || !dueDate) {
    failCreate("Preencha cliente, descrição, emissão e vencimento.");
  }

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
      installmentCount,
      method,
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
  if (!receivableId || !receivedDate || !method) {
    fail("Preencha valor, data e método do recebimento.");
  }

  let amountCents = 0;
  try {
    assertPermission(session.actor, "receivable.settle");
    amountCents = parseBRLToCents(fdString(formData, "amount"));
  } catch (error) {
    fail(errorMessage(error));
  }
  if (amountCents <= 0) fail("O valor recebido deve ser positivo.");

  let result: SkillResult<unknown>;
  try {
    result = await callSkill(session, "contas_a_receber", {
      action: "register_receipt",
      receivableId,
      amountCents,
      receivedDate,
      method,
      bankAccountId: fdOptional(formData, "bankAccountId"),
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  if (result.status === "error") fail(skillErrorMessage(result));
  const remaining = (result.data as { remainingCents?: number } | null)?.remainingCents;
  ok(
    `Recebimento de ${formatBRL(amountCents)} registrado.` +
      (remaining !== undefined ? ` Saldo restante: ${formatBRL(remaining)}.` : "")
  );
}
