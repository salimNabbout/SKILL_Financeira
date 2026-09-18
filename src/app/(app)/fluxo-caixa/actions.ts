"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { ValidationError } from "@/core/errors";
import {
  createCashflowManualEntry,
  deleteCashflowManualEntry,
  putCashflowMapping,
  putCashflowParameters,
  updateCashflowManualEntry,
} from "@/app/api/_lib/cashflow";
import { errorMessage, fdOptional, fdString, parseBRLToCents } from "@/app/(app)/cadastros/_lib/form-utils";

const BASE = "/fluxo-caixa";

/** "15" | "15,5" | "-20" | "0,00" → pontos-base inteiros (15,5% = 1550). */
function percentToBp(raw: string): number {
  const s = raw.trim().replace(/\s|%/g, "").replace(",", ".");
  if (!/^[-+]?\d+(\.\d{1,2})?$/.test(s)) throw new ValidationError(`Percentual inválido: "${raw}". Use, por exemplo, 15 ou -20,5.`);
  return Math.round(Number(s) * 100);
}

/** Caminho de retorno seguro: só dentro da disciplina. */
function safeReturn(raw: string | undefined, fallback: string): string {
  return raw && raw.startsWith(`${BASE}`) ? raw : fallback;
}

function withMsg(path: string, key: "ok" | "erro", msg: string): string {
  return withParam(path, key, msg);
}

/** Acrescenta/atualiza um parâmetro no caminho (com ou sem query já presente). */
function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, "http://local");
  url.searchParams.set(key, value);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export async function saveParametersAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const year = Number(fdString(formData, "year"));
  const back = `${BASE}/parametros?ano=${year}`;
  let erro: string | undefined;
  try {
    const overrideRaw = fdOptional(formData, "realizedMonthsOverride");
    const versionRaw = fdOptional(formData, "version");
    const scenarios = (["otimista", "realista", "pessimista"] as const).map((code) => ({
      code,
      revenueAdjustmentBp: 0,
      expenseAdjustmentBp: 0,
      monthlyGrowthBp: 0,
      version: undefined as number | undefined,
    }));
    for (const s of scenarios) {
      s.revenueAdjustmentBp = percentToBp(fdString(formData, `${s.code}_receita`));
      s.expenseAdjustmentBp = percentToBp(fdString(formData, `${s.code}_despesa`));
      s.monthlyGrowthBp = percentToBp(fdString(formData, `${s.code}_crescimento`));
      const v = fdOptional(formData, `${s.code}_version`);
      s.version = v ? Number(v) : undefined;
    }
    await putCashflowParameters(container, session, {
      year,
      openingBalanceCents: parseBRLToCents(fdString(formData, "openingBalance")),
      minimumReserveCents: parseBRLToCents(fdString(formData, "minimumReserve")),
      realizedMonthsOverride: overrideRaw ? Number(overrideRaw) : null,
      version: versionRaw ? Number(versionRaw) : undefined,
      scenarios,
    });
  } catch (error) {
    erro = errorMessage(error);
  }
  revalidatePath(BASE, "layout");
  redirect(erro ? withMsg(back, "erro", erro) : withMsg(back, "ok", "Parâmetros e cenários gravados. Todos os resultados foram recalculados."));
}

export async function saveMappingAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const back = safeReturn(fdOptional(formData, "returnTo"), `${BASE}/parametros`);
  let erro: string | undefined;
  let msg = "De-para gravado.";
  try {
    const versionRaw = fdOptional(formData, "version");
    const priorityRaw = fdOptional(formData, "priority");
    const { created, entity } = await putCashflowMapping(container, session, {
      source: fdString(formData, "source"),
      sourceKey: fdString(formData, "sourceKey"),
      categoryId: fdString(formData, "categoryId"),
      priority: priorityRaw ? Number(priorityRaw) : undefined,
      active: fdOptional(formData, "active") === undefined ? undefined : fdString(formData, "active") === "1",
      version: versionRaw ? Number(versionRaw) : undefined,
    });
    msg = created ? `De-para criado: "${entity.sourceKey}" → categoria gravada.` : `De-para atualizado: "${entity.sourceKey}".`;
  } catch (error) {
    erro = errorMessage(error);
  }
  revalidatePath(BASE, "layout");
  redirect(erro ? withMsg(back, "erro", erro) : withMsg(back, "ok", msg));
}

function manualBody(formData: FormData) {
  const costCenter = fdOptional(formData, "costCenterId");
  const note = fdOptional(formData, "sourceNote");
  return {
    competenceDate: fdString(formData, "competenceDate"),
    kind: fdString(formData, "kind"),
    categoryId: fdString(formData, "categoryId"),
    description: fdString(formData, "description"),
    costCenterId: costCenter ?? null,
    status: fdString(formData, "status"),
    amountCents: parseBRLToCents(fdString(formData, "amount")),
    sourceNote: note ?? null,
  };
}

export async function createManualEntryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const back = safeReturn(fdOptional(formData, "returnTo"), `${BASE}/lancamentos`);
  let erro: string | undefined;
  try {
    await createCashflowManualEntry(container, session, manualBody(formData));
  } catch (error) {
    erro = errorMessage(error);
  }
  revalidatePath(BASE, "layout");
  redirect(erro ? withMsg(back, "erro", erro) : withMsg(back, "ok", "Ajuste manual criado."));
}

export async function updateManualEntryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const id = fdString(formData, "id");
  const back = safeReturn(fdOptional(formData, "returnTo"), `${BASE}/lancamentos`);
  let erro: string | undefined;
  try {
    const versionRaw = fdOptional(formData, "version");
    await updateCashflowManualEntry(container, session, id, { ...manualBody(formData), version: versionRaw ? Number(versionRaw) : undefined });
  } catch (error) {
    erro = errorMessage(error);
  }
  revalidatePath(BASE, "layout");
  redirect(erro ? withMsg(withParam(back, "editar", id), "erro", erro) : withMsg(back, "ok", "Ajuste manual alterado."));
}

export async function deleteManualEntryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const id = fdString(formData, "id");
  const back = safeReturn(fdOptional(formData, "returnTo"), `${BASE}/lancamentos`);
  let erro: string | undefined;
  try {
    await deleteCashflowManualEntry(container, session, id);
  } catch (error) {
    erro = errorMessage(error);
  }
  revalidatePath(BASE, "layout");
  redirect(erro ? withMsg(back, "erro", erro) : withMsg(back, "ok", "Ajuste manual excluído (valor anterior guardado na auditoria)."));
}
