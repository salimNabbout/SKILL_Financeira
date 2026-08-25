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
  const supplierCategory = fdOptional(formData, "supplierCategory");
  const costRaw = fdOptional(formData, "costClassification");
  // Todos os campos são obrigatórios (validação no servidor, além do required do HTML).
  if (!supplierId || !description || !issueDate || !dueDate) {
    fail("Preencha fornecedor, descrição, emissão e vencimento.");
  }
  if (!supplierCategory) fail("Selecione a categoria.");
  if (costRaw !== "fixed" && costRaw !== "variable") {
    fail("Selecione a classificação do custo (Fixo ou Variável).");
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

  const costClassification: Supplier["costClassification"] = costRaw;

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
        supplierCategory,
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

export async function updatePayableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const payableId = fdString(formData, "payableId");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  const supplierCategory = fdOptional(formData, "supplierCategory");
  const costRaw = fdOptional(formData, "costClassification");
  const notes = fdOptional(formData, "notes");
  const amountRaw = fdString(formData, "amount");

  // Reabre o formulário inline na MESMA linha, preservando o que foi digitado
  // (searchParams → defaultValue), no mesmo espírito do formulário de novo título.
  // Function declaration (não arrow) para que o retorno `never` estreite o
  // control-flow — o TS só faz isso com declarações de função.
  function failEdit(message: string): never {
    const qs = new URLSearchParams({ editar: payableId, erro: message });
    if (description) qs.set("f_descricao", description);
    if (issueDate) qs.set("f_emissao", issueDate);
    if (dueDate) qs.set("f_vencimento", dueDate);
    if (amountRaw) qs.set("f_valor", amountRaw);
    if (supplierCategory) qs.set("f_categoria", supplierCategory);
    if (costRaw) qs.set("f_custo", costRaw);
    if (notes) qs.set("f_notas", notes);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!payableId) fail("Título não identificado para edição.");
  if (!description || !issueDate || !dueDate) {
    failEdit("Preencha descrição, emissão e vencimento.");
  }
  if (costRaw !== undefined && costRaw !== "fixed" && costRaw !== "variable") {
    failEdit("Classificação de custo inválida (Fixo ou Variável).");
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
      flow: "update_payable",
      companyId: session.company.id,
      actor: session.actor,
      payload: {
        payableId,
        description,
        issueDate,
        dueDate,
        amountCents,
        supplierCategory,
        costClassification: costRaw as "fixed" | "variable" | undefined,
        notes,
      },
    });
  } catch (error) {
    failEdit(errorMessage(error));
  }

  if (response.status === "failed") failEdit(flowErrorMessage(response));

  ok("Título atualizado.");
}

export async function schedulePaymentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator, repos } = await getContainer();

  const payableId = fdString(formData, "payableId");
  const bankAccountId = fdString(formData, "bankAccountId");
  const scheduledDate = fdString(formData, "scheduledDate");
  if (!payableId || !bankAccountId || !scheduledDate) {
    fail("Preencha conta bancária e data do pagamento.");
  }

  // Fornecedor do título, para a mensagem deixar claro o que foi enviado.
  let supplierName = "";
  let payableAmount: number | undefined;
  try {
    const payable = await repos.payables.getById(session.company.id, payableId);
    if (payable) {
      payableAmount = payable.amountCents;
      const supplier = await repos.suppliers.getById(session.company.id, payable.supplierId);
      supplierName = supplier?.name ?? payable.supplierId;
    }
  } catch {
    // Falha ao resolver o nome não deve impedir o fluxo; segue sem o nome.
  }

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "schedule_payment",
      companyId: session.company.id,
      actor: session.actor,
      payload: { payableId, bankAccountId, scheduledDate },
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  if (response.status === "failed") fail(flowErrorMessage(response));

  // O botão "Pagar" NÃO paga: schedule_payment cria um Payment pendente de
  // aprovação. A mensagem explicita que nada foi pago — segue para /aprovacoes.
  const amount = response.approval?.amountCents ?? payableAmount;
  const quem = supplierName ? `de ${supplierName} ` : "";
  const quanto = amount !== undefined ? `— ${formatBRL(amount)} ` : "";
  ok(`Pagamento ${quem}${quanto}enviado para aprovação.`);
}
