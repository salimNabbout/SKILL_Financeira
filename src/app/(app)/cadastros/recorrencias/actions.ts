"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { isISODate } from "@/core/dates";
import type { CostClassification, RecurringStatus, RecurringTemplate } from "@/core/entities";
import {
  errorMessage,
  fdOptional,
  fdString,
  parseBRLToCents,
  toTitleCase,
} from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/recorrencias";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

/** Cadastra uma recorrência (por enquanto, apenas do tipo "a pagar"). */
export async function createRecurringAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }

  const counterpartyId = fdString(formData, "counterpartyId");
  const description = fdString(formData, "description");
  const dueDayRaw = fdString(formData, "dueDay");
  const startDate = fdString(formData, "startDate");
  if (!counterpartyId) fail("Selecione o fornecedor.");
  if (!description) fail("Informe a descrição.");
  if (!startDate || !isISODate(startDate)) fail("Informe a data de início.");

  const dueDay = Number(dueDayRaw);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    fail("Dia do vencimento inválido (1 a 31).");
  }

  const endDate = fdOptional(formData, "endDate");
  if (endDate && !isISODate(endDate)) fail("Data-fim inválida.");
  if (endDate && endDate < startDate) fail("A data-fim não pode ser anterior ao início.");

  const category = fdOptional(formData, "category");
  const costRaw = fdOptional(formData, "costClassification");
  const costClassification: CostClassification | undefined =
    costRaw === "fixed" || costRaw === "variable" ? costRaw : undefined;

  let amountCents = 0;
  try {
    amountCents = parseBRLToCents(fdString(formData, "amount"));
  } catch (error) {
    fail(errorMessage(error));
  }
  if (amountCents <= 0) fail("O valor mensal deve ser positivo.");

  try {
    const now = container.clock.now().toISOString();
    const template: RecurringTemplate = {
      id: container.ids.next("rec"),
      companyId,
      kind: "payable",
      counterpartyId,
      description,
      amountCents,
      dueDay,
      category: category ? toTitleCase(category) : undefined,
      costClassification,
      startDate,
      endDate,
      status: "active",
      createdBy: session.actor.id,
      createdAt: now,
      updatedAt: now,
    };
    await container.repos.recurringTemplates.create(template);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "recurring_template.created",
      entityType: "recurring_template",
      entityId: template.id,
      after: template,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Recorrência "${description}" cadastrada.`);
}

/** Muda o status de uma recorrência (pausar/retomar/encerrar). */
export async function setRecurringStatusAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  const status = fdString(formData, "status") as RecurringStatus;
  if (!id) fail("Recorrência inválida.");
  if (status !== "active" && status !== "paused" && status !== "ended") {
    fail("Status inválido.");
  }

  let updated: RecurringTemplate;
  try {
    const current = await container.repos.recurringTemplates.getById(companyId, id);
    if (!current) throw new Error("Recorrência não encontrada.");
    updated = await container.repos.recurringTemplates.update({
      ...current,
      status,
      updatedAt: container.clock.now().toISOString(),
    });
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "recurring_template.updated",
      entityType: "recurring_template",
      entityId: updated.id,
      after: updated,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  const label =
    status === "paused" ? "pausada" : status === "ended" ? "encerrada" : "reativada";
  ok(`Recorrência ${label}.`);
}
