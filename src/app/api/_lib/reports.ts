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
import { runSkill, type SkillContext, type SkillName } from "@/core/skill";
import { formatBRL } from "@/core/money";
import type { ReconciliationAuditData } from "@/skills/conciliacao";
import type { SkillResult } from "@/core/types";
import { hasPermission } from "@/core/auth";
import { PermissionError } from "@/core/errors";
import type { ApiDeps, ApiSession } from "./handlers";
import { periodSchema } from "./handlers";

export const REPORT_NAMES = [
  "daily_summary",
  "monthly_close",
  "executive_overview",
  "reconciliation_audit",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export const reportQuerySchema = z.object({
  format: z.enum(["json", "csv", "xlsx", "pdf"]).default("json"),
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
  | { kind: "xlsx"; filename: string; bytes: Uint8Array }
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
  buildXlsx(
    sheets: Array<{
      name: string;
      columns?: Array<{ key: string; label: string; type?: "text" | "money" | "number" }>;
      rows: Array<Record<string, unknown>>;
    }>
  ): Uint8Array;
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
  const { repos, events, audit, clock, ids, ai, integrations } = deps;
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
    integrations,
    correlationId: ids.next("corr"),
    today: () => todayInTz(clock.now(), config.timezone),
  };
}

/**
 * Qual skill produz cada relatório.
 *
 * Antes isto era implícito: tudo ia para `relatorios_gerenciais`, e o nome do
 * relatório era validado num enum dentro dela. A auditoria de conciliação mora
 * na skill de conciliação — sem este mapa, a requisição morreria na validação
 * da skill errada.
 */
const REPORT_SOURCES: Record<ReportName, { skill: SkillName; action: string }> = {
  daily_summary: { skill: "relatorios_gerenciais", action: "daily_summary" },
  monthly_close: { skill: "relatorios_gerenciais", action: "monthly_close" },
  executive_overview: { skill: "relatorios_gerenciais", action: "executive_overview" },
  reconciliation_audit: { skill: "conciliacao_bancaria", action: "reconciliation_audit" },
};

/** Relatórios que exigem `period` na consulta. */
const REPORTS_COM_PERIODO: ReportName[] = ["monthly_close", "reconciliation_audit"];

async function runReportSkill(
  deps: ApiDeps,
  session: ApiSession,
  input: Record<string, unknown>,
  skill: SkillName = "relatorios_gerenciais"
): Promise<SkillResult> {
  const def = deps.registry.get(skill);
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

/**
 * Uma linha por DIVERGÊNCIA, com a coluna `tipo` separando os quatro blocos.
 * Fica aqui, e não na skill, porque é formatação de saída — a skill devolve os
 * fatos, o relatório decide como enfileirá-los.
 */
function linhasDaAuditoria(d: ReconciliationAuditData): Array<Record<string, unknown>> {
  const linhas: Array<Record<string, unknown>> = [];
  for (const t of d.unexplainedBankTransactions) {
    linhas.push({
      tipo: "Extrato sem explicação",
      data: t.date,
      descricao: t.description,
      contraparte: "",
      valor: t.amountCents / 100,
      observacao: t.hasSuggestion ? "Tem sugestão pendente" : "Sem sugestão",
      referencia: t.id,
    });
  }
  for (const b of d.settlementsWithoutBank) {
    const rotulo =
      b.kind === "payment"
        ? "Pagamento sem lastro"
        : b.kind === "receipt"
          ? "Recebimento sem lastro"
          : "Título baixado sem pagamento";
    linhas.push({
      tipo: rotulo,
      data: b.date,
      descricao: b.description,
      contraparte: b.counterparty,
      valor: b.amountCents / 100,
      observacao: b.registeredBy ? `Registrado por ${b.registeredBy}` : "",
      referencia: b.id,
    });
  }
  for (const m of d.amountMismatches) {
    linhas.push({
      tipo: "Valor divergente",
      data: "",
      descricao: `Aplicado ${formatBRL(m.appliedCents)} contra ${formatBRL(m.expectedCents)} esperado`,
      contraparte: `${m.targetType} ${m.targetId ?? ""}`.trim(),
      valor: m.diffCents / 100,
      observacao: `Transação ${m.bankTransactionId}`,
      referencia: m.matchId,
    });
  }
  for (const b of d.balanceChecks) {
    if (b.residualCents === 0) continue;
    linhas.push({
      tipo: "Saldo divergente",
      data: b.asOf,
      descricao: `Banco ${formatBRL(b.ledgerBalanceCents)}, app ${formatBRL(b.computedBalanceCents)}`,
      contraparte: b.bankName,
      valor: b.residualCents / 100,
      observacao: `Diferença ${formatBRL(b.diffCents)}, explicado ${formatBRL(b.explainedCents)}`,
      referencia: b.importId,
    });
  }
  return linhas;
}

const COLUNAS_AUDITORIA = [
  { key: "tipo", label: "Tipo" },
  { key: "data", label: "Data" },
  { key: "descricao", label: "Descrição" },
  { key: "contraparte", label: "Contraparte" },
  { key: "valor", label: "Valor" },
  { key: "observacao", label: "Observação" },
  { key: "referencia", label: "Referência" },
];

async function renderAuditoriaConciliacao(
  d: ReconciliationAuditData,
  query: ReportQuery,
  filenameBase: string
): Promise<ReportOutput> {
  const linhas = linhasDaAuditoria(d);
  const titulo = "Auditoria de conciliação";
  const subtitulo = `${d.period.start} a ${d.period.end}`;
  const exporters = await loadExporters();

  if (query.format === "csv") {
    return {
      kind: "csv",
      filename: `${filenameBase}.csv`,
      content: exporters.toCsv(linhas, COLUNAS_AUDITORIA.map((c) => ({ key: c.key, label: c.key }))),
    };
  }
  if (query.format === "xlsx") {
    return {
      kind: "xlsx",
      filename: `${filenameBase}.xlsx`,
      bytes: exporters.buildXlsx([
        {
          name: titulo,
          columns: COLUNAS_AUDITORIA.map((c) =>
            c.key === "valor" ? c : { ...c, type: "text" as const }
          ),
          rows: linhas,
        },
      ]),
    };
  }
  const bytes = await exporters.buildPdfReport({
    title: titulo,
    subtitle: subtitulo,
    sections: [
      {
        heading: "Divergências do período",
        table: {
          headers: COLUNAS_AUDITORIA.map((c) => c.label),
          rows: linhas.map((l) => COLUNAS_AUDITORIA.map((c) => String(l[c.key] ?? ""))),
        },
      },
    ],
  });
  return { kind: "pdf", filename: `${filenameBase}.pdf`, bytes };
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
  const nome = report as ReportName;
  if (REPORTS_COM_PERIODO.includes(nome) && !query.period) {
    throw new ValidationError(`O relatório ${nome} exige o parâmetro period (YYYY-MM).`);
  }
  const fonte = REPORT_SOURCES[nome];

  if (query.format === "json") {
    const result = await runReportSkill(
      deps,
      session,
      { action: fonte.action, ...(query.period ? { period: query.period } : {}) },
      fonte.skill
    );
    return { kind: "json", result };
  }

  // A auditoria de conciliação não passa por `export_data`: as linhas são uma
  // por DIVERGÊNCIA, não pares métrica/valor.
  if (nome === "reconciliation_audit") {
    const result = await runReportSkill(
      deps,
      session,
      { action: fonte.action, period: query.period },
      fonte.skill
    );
    return renderAuditoriaConciliacao(
      result.data as ReconciliationAuditData,
      query,
      `${nome}-${query.period}`
    );
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

  if (query.format === "xlsx") {
    // Tipos autodetectados: "valor" numérico vira célula numérica no Excel.
    const bytes = exporters.buildXlsx([
      {
        name: title,
        columns: [
          { key: "metrica", label: "Métrica", type: "text" },
          { key: "valor", label: "Valor" },
          { key: "unidade", label: "Unidade", type: "text" },
          { key: "fonte", label: "Fonte", type: "text" },
        ],
        rows: rows as Array<Record<string, unknown>>,
      },
    ]);
    return { kind: "xlsx", filename: `${filenameBase}.xlsx`, bytes };
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
