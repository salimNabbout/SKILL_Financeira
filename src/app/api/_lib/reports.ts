/**
 * Geração de relatórios via skill "relatorios_gerenciais", executada
 * DIRETAMENTE com runSkill (sem passar pelo orquestrador) — mesma montagem de
 * SkillContext que o orquestrador usa, com o ator da sessão.
 *
 * Formatos: json (envelope SkillResult), csv e pdf (via @/lib/exporters, cujo
 * módulo é carregado sob demanda para não acoplar os demais endpoints a ele).
 */

import { z } from "zod";
import { todayInTz } from "@/core/dates";
import { DomainError, ValidationError } from "@/core/errors";
import { runSkill, type SkillContext } from "@/core/skill";
import type { SkillResult } from "@/core/types";
import { hasPermission } from "@/core/auth";
import { PermissionError } from "@/core/errors";
import type { ApiDeps, ApiSession } from "./handlers";
import { periodSchema } from "./handlers";

export const REPORT_NAMES = ["daily_summary", "monthly_close", "executive_overview"] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export const reportQuerySchema = z.object({
  format: z.enum(["json", "csv", "pdf"]).default("json"),
  period: periodSchema.optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** Linhas do export_data da skill de relatórios (contrato do catálogo de skills). */
const exportDataSchema = z.object({
  report: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  rows: z.array(
    z
      .object({
        metrica: z.unknown().optional(),
        valor: z.unknown().optional(),
        unidade: z.unknown().optional(),
        fonte: z.unknown().optional(),
      })
      .passthrough()
  ),
});

export type ReportOutput =
  | { kind: "json"; result: SkillResult }
  | { kind: "csv"; filename: string; content: string }
  | { kind: "pdf"; filename: string; bytes: Uint8Array };

// ---------------------------------------------------------------------------
// Ponte para @/lib/exporters (implementado em módulo próprio; contrato fixo)
// ---------------------------------------------------------------------------

interface ExportersModule {
  toCsv(
    rows: Array<Record<string, unknown>>,
    columns?: Array<{ key: string; label: string }>
  ): string;
  buildPdfReport(opts: {
    title: string;
    subtitle?: string;
    sections: Array<{
      heading: string;
      lines?: string[];
      table?: { headers: string[]; rows: string[][] };
    }>;
  }): Promise<Uint8Array>;
}

async function loadExporters(): Promise<ExportersModule> {
  try {
    return (await import("@/lib/exporters")) as unknown as ExportersModule;
  } catch {
    throw new DomainError(
      "integration_unavailable",
      "Exportação CSV/PDF indisponível no momento (módulo de exportadores ausente)."
    );
  }
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

function buildReportContext(deps: ApiDeps, session: ApiSession): SkillContext {
  const { repos, events, audit, clock, ids, ai } = deps;
  const config = session.config;
  return {
    companyId: session.company.id,
    actor: session.actor,
    repos,
    events,
    audit,
    clock,
    ids,
    config,
    ai,
    correlationId: ids.next("corr"),
    today: () => todayInTz(clock.now(), config.timezone),
  };
}

async function runReportSkill(
  deps: ApiDeps,
  session: ApiSession,
  input: Record<string, unknown>
): Promise<SkillResult> {
  const def = deps.registry.get("relatorios_gerenciais");
  const ctx = buildReportContext(deps, session);
  const result = await runSkill(def, ctx, input);
  if (result.status === "error") {
    const first = result.alerts[0];
    throw new DomainError(
      first?.code ?? "report_failed",
      first?.message ?? "Falha ao gerar o relatório."
    );
  }
  return result as SkillResult;
}

export async function runReport(
  deps: ApiDeps,
  session: ApiSession,
  report: string,
  rawQuery: unknown
): Promise<ReportOutput> {
  if (!hasPermission(session.membership.role, "report.view")) {
    throw new PermissionError(
      `Papel ${session.membership.role} não possui a permissão report.view.`
    );
  }
  if (!REPORT_NAMES.includes(report as ReportName)) {
    throw new ValidationError(
      `Relatório desconhecido: ${report}. Disponíveis: ${REPORT_NAMES.join(", ")}.`
    );
  }
  const parsed = reportQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Entrada inválida: ${detail}`);
  }
  const query = parsed.data;
  if (report === "monthly_close" && !query.period) {
    throw new ValidationError("O relatório monthly_close exige o parâmetro period (YYYY-MM).");
  }

  if (query.format === "json") {
    const result = await runReportSkill(deps, session, {
      action: report,
      ...(query.period ? { period: query.period } : {}),
    });
    return { kind: "json", result };
  }

  // CSV/PDF usam a ação export_data (linhas metrica/valor/unidade/fonte).
  const result = await runReportSkill(deps, session, {
    action: "export_data",
    report,
    ...(query.period ? { period: query.period } : {}),
  });
  const data = exportDataSchema.safeParse(result.data);
  if (!data.success) {
    throw new DomainError(
      "report_export_invalid",
      "A skill de relatórios devolveu export_data em formato inesperado."
    );
  }
  const { title, subtitle, rows } = data.data;
  const filenameBase = `${report}${query.period ? `-${query.period}` : ""}`;
  const exporters = await loadExporters();

  if (query.format === "csv") {
    const content = exporters.toCsv(rows as Array<Record<string, unknown>>, [
      { key: "metrica", label: "metrica" },
      { key: "valor", label: "valor" },
      { key: "unidade", label: "unidade" },
      { key: "fonte", label: "fonte" },
    ]);
    return { kind: "csv", filename: `${filenameBase}.csv`, content };
  }

  const bytes = await exporters.buildPdfReport({
    title,
    subtitle,
    sections: [
      {
        heading: "Indicadores",
        table: {
          headers: ["Métrica", "Valor", "Unidade", "Fonte"],
          rows: rows.map((r) => [
            String(r.metrica ?? ""),
            String(r.valor ?? ""),
            String(r.unidade ?? ""),
            String(r.fonte ?? ""),
          ]),
        },
      },
    ],
  });
  return { kind: "pdf", filename: `${filenameBase}.pdf`, bytes };
}
