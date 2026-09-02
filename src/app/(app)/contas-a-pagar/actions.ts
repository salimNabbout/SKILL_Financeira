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

// Descrição pode ser longa; ao PROPAGAR na URL truncamos para não estourar o
// limite de tamanho. Truncagem só na propagação — nunca no que seria salvo.
const MAX_URL_DESCRIPTION = 200;

export async function createPayableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator, repos } = await getContainer();

  // O campo Fornecedor é um autocompletar nativo (<input list>) que submete o
  // NOME; resolvemos nome → id abaixo (nomes são únicos por empresa).
  const supplierName = fdString(formData, "supplierName");
  const description = fdString(formData, "description");
  const issueDate = fdString(formData, "issueDate");
  const dueDate = fdString(formData, "dueDate");
  const supplierCategory = fdOptional(formData, "supplierCategory");
  const costRaw = fdOptional(formData, "costClassification");
  const costCenterId = fdOptional(formData, "costCenterId");
  const documentNumber = fdOptional(formData, "documentNumber");
  const tipo = fdOptional(formData, "tipoLancamento") ?? "parcelado";
  const isRecorrente = tipo === "recorrente";
  const amountRaw = fdString(formData, "amount");
  const installmentRaw = fdOptional(formData, "installmentCount");
  const frequencyRaw = fdString(formData, "recurrenceFrequency");
  const occurrencesRaw = fdString(formData, "recurrenceOccurrences");

  // Falha na CRIAÇÃO: reexibe o Card "Novo título" com TUDO que foi digitado
  // (searchParams nt_* → defaultValue), inclusive o campo errado. Marca
  // nt_erro=data quando a validação é de datas, para a page destacar Emissão/
  // Vencimento e dar autoFocus no Vencimento. Preserva o NOME digitado do
  // fornecedor (não o id — pode não ter resolvido).
  function failCreate(message: string): never {
    const qs = new URLSearchParams({ erro: message });
    if (/Verificar a Data da Emissão/i.test(message)) qs.set("nt_erro", "data");
    if (supplierName) qs.set("nt_fornecedor", supplierName);
    if (description) qs.set("nt_descricao", description.slice(0, MAX_URL_DESCRIPTION));
    if (amountRaw) qs.set("nt_valor", amountRaw);
    if (issueDate) qs.set("nt_emissao", issueDate);
    if (dueDate) qs.set("nt_vencimento", dueDate);
    if (supplierCategory) qs.set("nt_categoria", supplierCategory);
    if (costRaw) qs.set("nt_custo", costRaw);
    if (costCenterId) qs.set("nt_centrocusto", costCenterId);
    if (documentNumber) qs.set("nt_documento", documentNumber);
    qs.set("nt_tipo", isRecorrente ? "recorrente" : "parcelado");
    if (installmentRaw) qs.set("nt_parcelas", installmentRaw);
    if (frequencyRaw) qs.set("nt_frequencia", frequencyRaw);
    if (occurrencesRaw) qs.set("nt_ocorrencias", occurrencesRaw);
    redirect(`${PATH}?${qs.toString()}`);
  }

  // Todos os campos são obrigatórios (validação no servidor, além do required do HTML).
  if (!supplierName || !description || !issueDate || !dueDate) {
    failCreate("Preencha fornecedor, descrição, emissão e vencimento.");
  }
  if (!supplierCategory) failCreate("Selecione a categoria.");
  if (costRaw !== "fixed" && costRaw !== "variable") {
    failCreate("Selecione a classificação do custo (Fixo ou Variável).");
  }
  if (!costCenterId) failCreate("Selecione o centro de custo.");

  // Resolve nome → id: comparação case-insensitive, ignorando espaços nas
  // pontas. NUNCA escolhe o primeiro em caso de ambiguidade.
  const wanted = supplierName.trim().toLowerCase();
  const matches = (await repos.suppliers.listAll(session.company.id)).filter(
    (s) => s.active && s.name.trim().toLowerCase() === wanted
  );
  if (matches.length === 0) {
    failCreate("Fornecedor não encontrado. Selecione um da lista.");
  }
  if (matches.length > 1) {
    failCreate(
      `Há mais de um fornecedor com o nome "${supplierName.trim()}". Ajuste o cadastro para diferenciá-los antes de lançar o título.`
    );
  }
  const supplierId = matches[0].id;

  let amountCents = 0;
  let installmentCount = 1;
  let recurrence: { frequency: string; occurrences: number } | undefined;
  try {
    amountCents = parseBRLToCents(amountRaw);
    if (isRecorrente) {
      if (!["weekly", "monthly", "quarterly", "yearly"].includes(frequencyRaw)) {
        failCreate("Selecione a frequência da recorrência.");
      }
      const occurrences = Number(occurrencesRaw);
      if (!Number.isInteger(occurrences) || occurrences < 2) {
        failCreate("Número de ocorrências inválido (mínimo 2).");
      }
      recurrence = { frequency: frequencyRaw, occurrences };
    } else {
      installmentCount = Number(installmentRaw ?? "1");
    }
  } catch (error) {
    failCreate(errorMessage(error));
  }
  if (amountCents <= 0) failCreate("O valor do título deve ser positivo.");
  if (!isRecorrente && (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 120)) {
    failCreate("Número de parcelas inválido (1 a 120).");
  }

  const costClassification: Supplier["costClassification"] = costRaw;

  // Documento fiscal OPCIONAL: montado só quando o Nº do Doc. foi informado.
  // Preencher o número torna-o a chave de deduplicação (originKey) na skill.
  // type fixo "other"; issuedAt = Emissão; totalCents = Valor (já validado > 0).
  // NÃO enviar objeto incompleto: sem número, a chave `document` fica ausente.
  const document = documentNumber
    ? { type: "other" as const, number: documentNumber, issuedAt: issueDate, totalCents: amountCents }
    : undefined;

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
        // Centro de custo é opcional: só entra no payload quando selecionado
        // (string vazia vira undefined via fdOptional; não enviar a chave vazia).
        ...(costCenterId ? { costCenterId } : {}),
        // Documento é opcional: só entra quando o Nº do Doc. foi informado.
        ...(document ? { document } : {}),
        // Mutuamente exclusivos: recorrência envia `recurrence`; caso contrário
        // `installmentCount`. NÃO envia a chave de recorrência quando ausente
        // (a skill espera undefined, não objeto vazio).
        ...(isRecorrente ? { recurrence } : { installmentCount }),
      },
    });
  } catch (error) {
    failCreate(errorMessage(error));
  }

  const created = response.results.find((r) => r.stepId === "ap_create")?.result;
  const payables = (created?.data as { payables?: Payable[] } | null)?.payables ?? [];
  if (response.status === "failed" && payables.length === 0) {
    failCreate(flowErrorMessage(response));
  }
  const totalCents = payables.reduce((acc, p) => acc + p.amountCents, 0);
  ok(
    (isRecorrente
      ? `Recorrência criada: ${payables.length} título(s) de ${formatBRL(amountCents)} — total ${formatBRL(totalCents)}.`
      : `Título criado: ${payables.length} parcela(s) somando ${formatBRL(amountCents)}.`) +
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
  const costCenterId = fdOptional(formData, "costCenterId");
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
    if (costCenterId) qs.set("f_centrocusto", costCenterId);
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
        // Centro de custo agora é editável (a skill já aceitava no update):
        // vazio vira undefined e MANTÉM o atual — a skill só limpa com null.
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

export async function cancelPayableAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const payableId = fdString(formData, "payableId");
  const reason = fdString(formData, "reason");

  // Reabre o form inline de exclusão na mesma linha, preservando o motivo.
  function failCancel(message: string): never {
    const qs = new URLSearchParams({ excluir: payableId, erro: message });
    if (reason) qs.set("f_motivo", reason);
    redirect(`${PATH}?${qs.toString()}`);
  }

  if (!payableId) fail("Título não identificado para exclusão.");
  // reason é obrigatório na skill; exigimos aqui para dar mensagem clara e não
  // inventar texto padrão (que esvaziaria a auditoria).
  if (!reason) failCancel("Informe o motivo do cancelamento.");

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "cancel_payable",
      companyId: session.company.id,
      actor: session.actor,
      payload: { payableId, reason },
    });
  } catch (error) {
    failCancel(errorMessage(error));
  }

  if (response.status === "failed") failCancel(flowErrorMessage(response));

  ok("Título cancelado e mantido no histórico para auditoria.");
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

  // Requisição repetida (mesma chave de idempotência: fluxo + título + conta +
  // data): NADA foi criado. Dizer "enviado para aprovação" aqui é mentira — era
  // o que mandava o usuário procurar em Aprovações uma solicitação inexistente.
  if (response.idempotent_replay) {
    ok(
      "Nada foi enviado: já existe uma solicitação igual para este título (mesma conta e mesma data) e ela não foi duplicada. " +
        "Se a anterior ainda está pendente, decida-a em Aprovações; se já foi decidida, altere a data do pagamento para enviar uma nova."
    );
  }

  ok(`Pagamento ${quem}${quanto}enviado para aprovação.`);
}
