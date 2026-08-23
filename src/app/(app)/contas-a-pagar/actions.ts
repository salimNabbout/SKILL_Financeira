"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import type { Payable, Supplier } from "@/core/entities";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import {
  errorMessage,
  fdOptional,
  fdString,
  flowErrorMessage,
  parseBRLToCents,
} from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/contas-a-pagar";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createPayableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const supplierId = fdString(formData, "supplierId");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  if (!supplierId || !description || !issueDate || !dueDate) {
    fail("Preencha fornecedor, descrição, emissão e vencimento.");
  }

  let amountCents = 0;
  let installmentCount = 1;
  try {
    amountCents = parseBRLToCents(fdString(formData, "amount"));
    installmentCount = Number(fdOptional(formData, "installmentCount") ?? "1");
  } catch (error) {
    fail(errorMessage(error));
  }
  if (amountCents <= 0) fail("O valor do título deve ser positivo.");
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 120) {
    fail("Número de parcelas inválido (1 a 120).");
  }

  // Classificação de custo é selecionável na tela (fixed | variable).
  const costRaw = fdOptional(formData, "costClassification");
  const costClassification: Supplier["costClassification"] =
    costRaw === "fixed" || costRaw === "variable" ? costRaw : undefined;

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "supplier_invoice_intake",
      companyId: session.company.id,
      actor: session.actor,
      payload: {
        supplierId,
        description,
        issueDate,
        dueDate,
        amountCents,
        // A caixa "Categoria" agora lista Categorias de Fornecedores (texto),
        // gravadas em supplierCategory; a categoria contábil (categoryId) passa
        // a ser sempre sugerida automaticamente pelo skill.
        supplierCategory: fdOptional(formData, "supplierCategory"),
        costClassification,
        installmentCount,
      },
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  const created = response.results.find((r) => r.stepId === "ap_create")?.result;
  const payables = (created?.data as { payables?: Payable[] } | null)?.payables ?? [];
  if (response.status === "failed" && payables.length === 0) {
    fail(flowErrorMessage(response));
  }
  ok(
    `Título criado: ${payables.length} parcela(s) somando ${formatBRL(amountCents)}.` +
      (response.idempotent_replay ? " (requisição repetida — nada foi duplicado)" : "")
  );
}

export async function schedulePaymentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const payableId = fdString(formData, "payableId");
  const bankAccountId = fdString(formData, "bankAccountId");
  const scheduledDate = fdString(formData, "scheduledDate");
  const method = fdString(formData, "method");
  if (!payableId || !bankAccountId || !scheduledDate || !method) {
    fail("Preencha conta bancária, data e método do pagamento.");
  }

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "schedule_payment",
      companyId: session.company.id,
      actor: session.actor,
      payload: { payableId, bankAccountId, scheduledDate, method },
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  if (response.status === "failed") fail(flowErrorMessage(response));
  if (response.status === "awaiting_approval") {
    const amount = response.approval?.amountCents;
    ok(
      `Aprovação solicitada${amount !== undefined ? ` (${formatBRL(amount)})` : ""} — acompanhe em Aprovações.`
    );
  }
  ok(`Fluxo de pagamento concluído: ${response.consolidated.summary}`);
}
