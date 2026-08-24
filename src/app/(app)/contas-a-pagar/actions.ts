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

/**
 * Campos do formulário de novo título devolvidos na URL quando a criação
 * falha. Prefixados com `f_` para não colidirem com os filtros da listagem
 * (status, ano, mes, fornecedor, de, ate).
 */
const CAMPOS_NOVO_TITULO = [
  "supplierId",
  "description",
  "amount",
  "issueDate",
  "dueDate",
  "installmentCount",
  "supplierCategory",
  "costClassification",
  "costCenterId",
] as const;

/**
 * Falha preservando o que o usuário digitou.
 *
 * Sem isso, um erro de validação (ex.: vencimento antes da emissão) recarrega
 * a página e apaga o formulário inteiro — o usuário redigita tudo para corrigir
 * um campo. Só os campos do título trafegam; nada sensível.
 */
function failComFormulario(message: string, formData: FormData): never {
  const params = new URLSearchParams({ erro: message });
  for (const campo of CAMPOS_NOVO_TITULO) {
    const valor = formData.get(campo);
    if (typeof valor === "string" && valor !== "") params.set(`f_${campo}`, valor);
  }
  redirect(`${PATH}?${params.toString()}`);
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
    failComFormulario("Preencha fornecedor, descrição, emissão e vencimento.", formData);
  }
  if (!supplierCategory) failComFormulario("Selecione a categoria.", formData);
  if (costRaw !== "fixed" && costRaw !== "variable") {
    failComFormulario("Selecione a classificação do custo (Fixo ou Variável).", formData);
  }

  let amountCents = 0;
  let installmentCount = 1;
  try {
    amountCents = parseBRLToCents(fdString(formData, "amount"));
    installmentCount = Number(fdOptional(formData, "installmentCount") ?? "1");
  } catch (error) {
    failComFormulario(errorMessage(error), formData);
  }
  if (amountCents <= 0) failComFormulario("O valor do título deve ser positivo.", formData);
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 120) {
    failComFormulario("Número de parcelas inválido (1 a 120).", formData);
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
        // Vazio não vira string vazia: a skill espera undefined (campo .optional()).
        ...(fdOptional(formData, "costCenterId")
          ? { costCenterId: fdOptional(formData, "costCenterId") }
          : {}),
      },
    });
  } catch (error) {
    failComFormulario(errorMessage(error), formData);
  }

  const created = response.results.find((r) => r.stepId === "ap_create")?.result;
  const payables = (created?.data as { payables?: Payable[] } | null)?.payables ?? [];
  if (response.status === "failed" && payables.length === 0) {
    failComFormulario(flowErrorMessage(response), formData);
  }
  ok(
    `Título criado: ${payables.length} parcela(s) somando ${formatBRL(amountCents)}.` +
      (response.idempotent_replay ? " (requisição repetida — nada foi duplicado)" : "")
  );
}

/**
 * Edita um título a pagar. Passa pelo orquestrador (flow payable_update), que
 * chama a skill — as travas de integridade (o que já teve movimento financeiro
 * não muda) vivem lá, não aqui.
 */
export async function updatePayableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator, repos } = await getContainer();
  const companyId = session.company.id;

  const payableId = fdString(formData, "payableId");
  if (!payableId) fail("Título não informado.");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  if (!description || !issueDate || !dueDate) {
    fail("Preencha descrição, emissão e vencimento.");
  }

  let amountCents = 0;
  try {
    amountCents = parseBRLToCents(fdString(formData, "amount"));
  } catch (error) {
    fail(errorMessage(error));
  }
  if (amountCents <= 0) fail("O valor do título deve ser positivo.");

  // O `before` sai do repositório ANTES da execução: a auditoria da skill
  // registra o par, e aqui usamos só para a mensagem de retorno.
  const before = await repos.payables.getById(companyId, payableId);
  if (!before) fail("Título não encontrado.");

  const costRaw = fdOptional(formData, "costClassification");
  const costCenterId = fdOptional(formData, "costCenterId");
  const supplierCategory = fdOptional(formData, "supplierCategory");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "payable_update",
      companyId,
      actor: session.actor,
      payload: {
        payableId,
        description,
        issueDate,
        dueDate,
        amountCents,
        ...(supplierCategory ? { supplierCategory } : {}),
        ...(costRaw === "fixed" || costRaw === "variable" ? { costClassification: costRaw } : {}),
        ...(costCenterId ? { costCenterId } : {}),
      },
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  if (response.status === "failed") {
    fail(flowErrorMessage(response));
  }

  ok(`Título "${description}" atualizado.`);
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
