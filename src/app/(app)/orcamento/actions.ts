"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { assertPermission } from "@/core/auth";
import { errorMessage } from "@/app/(app)/cadastros/_lib/form-utils";
import { runSkillForSession } from "../_lib/run-skill";
import { parseBudgetCsv } from "./csv";

function backTo(period: string | null, query: string): never {
  const p = period ? `period=${encodeURIComponent(period)}&` : "";
  redirect(`/orcamento?${p}${query}`);
}

/**
 * Cria/atualiza o orçamento do ano a partir do CSV colado no formulário.
 * A escrita em si é da skill orcamento_planejamento (upsert_budget) — a action
 * apenas valida/parsea e repassa; ela nunca movimenta dinheiro.
 */
export async function upsertBudgetAction(formData: FormData): Promise<void> {
  const session = await requireSession();

  const period = typeof formData.get("period") === "string" ? String(formData.get("period")) : null;

  // Autorização no servidor: a UI esconde o formulário, mas a action precisa
  // recusar papéis sem budget.manage (a skill reforça em profundidade).
  try {
    assertPermission(session.actor, "budget.manage");
  } catch (error) {
    backTo(period, `erro=${encodeURIComponent(errorMessage(error))}`);
  }

  const yearRaw = String(formData.get("year") ?? "").trim();
  const year = Number.parseInt(yearRaw, 10);
  const name = String(formData.get("name") ?? "").trim() || `Orçamento ${yearRaw}`;
  const csv = String(formData.get("lines") ?? "");

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    backTo(period, `erro=${encodeURIComponent(`Ano inválido: "${yearRaw}".`)}`);
  }

  const parsed = parseBudgetCsv(csv);
  if (parsed.errors.length > 0) {
    const shown = parsed.errors.slice(0, 3).join(" | ");
    const extra = parsed.errors.length > 3 ? ` (+${parsed.errors.length - 3} erro(s))` : "";
    backTo(period, `erro=${encodeURIComponent(shown + extra)}`);
  }
  if (parsed.lines.length === 0) {
    backTo(
      period,
      `erro=${encodeURIComponent("Nenhuma linha válida no formato categoriaId;YYYY-MM;valor.")}`
    );
  }
  const foraDoAno = parsed.lines.filter((l) => !l.period.startsWith(`${year}-`));
  if (foraDoAno.length > 0) {
    backTo(
      period,
      `erro=${encodeURIComponent(
        `Período ${foraDoAno[0].period} não pertence ao ano ${year} do orçamento.`
      )}`
    );
  }

  const result = await runSkillForSession(session, "orcamento_planejamento", {
    action: "upsert_budget",
    name,
    year,
    lines: parsed.lines,
  });

  if (result.status === "error") {
    const message = result.alerts?.[0]?.message ?? "Falha ao salvar o orçamento.";
    backTo(period, `erro=${encodeURIComponent(message)}`);
  }

  revalidatePath("/orcamento");
  backTo(
    period,
    `msg=${encodeURIComponent(`Orçamento "${name}" salvo com ${parsed.lines.length} linha(s).`)}`
  );
}
