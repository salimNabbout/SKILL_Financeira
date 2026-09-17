/**
 * Painel por Período do Dashboard — endpoint único.
 *
 * Valida a query string (ano, mês, dias, centro de custo, categoria), aplica
 * os padrões (mês corrente, dia 1 até o último dia) e executa a ação
 * `period_panel` da skill de relatórios com o ator da sessão — mesma montagem
 * de contexto dos relatórios. A agregação acontece no banco (repositórios).
 */

import { z } from "zod";
import { todayInTz } from "@/core/dates";
import { ValidationError } from "@/core/errors";
import { defaultPeriodInput } from "@/core/period-panel";
import type { SkillResult } from "@/core/types";
import type { ApiDeps, ApiSession } from "./handlers";
import { runReportSkill } from "./reports";

const intFromQuery = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

/**
 * Parâmetros como chegam na URL (strings). `mes` aceita 1..12 ou "todos"
 * (ano inteiro); ausente = mês corrente. `de`/`ate` são dias do mês.
 */
export const periodPanelQuerySchema = z.object({
  ano: intFromQuery(1900, 2200).optional(),
  mes: z.union([z.literal("todos"), intFromQuery(1, 12)]).optional(),
  de: intFromQuery(1, 31).optional(),
  ate: intFromQuery(1, 31).optional(),
  cc: z.string().trim().min(1).optional(),
  cat: z.string().trim().min(1).optional(),
});
export type PeriodPanelQuery = z.infer<typeof periodPanelQuerySchema>;

export interface PeriodPanelSkillInput {
  action: "period_panel";
  year: number;
  month?: number;
  dayFrom?: number;
  dayTo?: number;
  costCenterId?: string;
  category?: string;
}

/** Query da URL → entrada da skill, com os padrões de "hoje" no fuso da empresa. */
export function toPeriodPanelInput(query: PeriodPanelQuery, today: string): PeriodPanelSkillInput {
  const padrao = defaultPeriodInput(today);
  const year = query.ano ?? padrao.year;
  if (query.mes === "todos") {
    return { action: "period_panel", year, costCenterId: query.cc, category: query.cat };
  }
  const month = query.mes ?? padrao.month;
  return {
    action: "period_panel",
    year,
    month,
    // Sem dias informados: dia 1 até o último dia (a skill ajusta ao mês).
    dayFrom: query.de ?? 1,
    dayTo: query.ate ?? 31,
    costCenterId: query.cc,
    category: query.cat,
  };
}

/** GET /api/v1/dashboard/period-panel — envelope SkillResult com PeriodPanelData. */
export async function getPeriodPanel(
  deps: ApiDeps,
  session: ApiSession,
  rawQuery: Record<string, string>
): Promise<SkillResult> {
  const parsed = periodPanelQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Parâmetros inválidos: ${detail}`);
  }
  const today = todayInTz(deps.clock.now(), session.config.timezone);
  return runReportSkill(deps, session, { ...toPeriodPanelInput(parsed.data, today) });
}
