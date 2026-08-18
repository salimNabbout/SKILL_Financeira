/**
 * Contrato padrão das skills e runner de execução.
 * Toda skill:
 *  - tem responsabilidade delimitada e objetivo declarados;
 *  - valida entrada com Zod;
 *  - devolve SkillResult (envelope JSON padrão);
 *  - declara eventos consumidos/publicados e fontes de dados;
 *  - é idempotente nas ações de escrita (via originKey/idempotência do orquestrador);
 *  - tem execução registrada (SkillExecution) e auditada.
 */

import type { ZodType } from "zod";
import type { Actor, ID } from "./entities";
import type { Repositories } from "./repositories";
import type { EventBus, EventType } from "./events";
import type { AuditTrail } from "./audit";
import type { Clock } from "./clock";
import { hashPayload, type IdGenerator } from "./ids";
import type { CompanyConfig } from "./config";
import type { AiClassifier } from "./ai";
import { todayInTz, type ISODate } from "./dates";
import { DomainError } from "./errors";
import type { PendingItem, SkillAlert, SkillResult, SkillStatus } from "./types";

export const SKILL_NAMES = [
  "contas_a_pagar",
  "contas_a_receber",
  "faturamento",
  "tesouraria_fluxo_caixa",
  "conciliacao_bancaria",
  "cobranca_inadimplencia",
  "orcamento_planejamento",
  "controladoria_indicadores",
  "integracao_contabil_fiscal",
  "controles_internos_auditoria",
  "relatorios_gerenciais",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

/** Decisão de aprovação repassada pelo orquestrador ao retomar um passo sensível. */
export interface ApprovalDecision {
  id: ID;
  status: "approved" | "rejected";
  decidedBy: ID;
  justification?: string;
}

export interface SkillContext {
  companyId: ID;
  actor: Actor;
  repos: Repositories;
  events: EventBus;
  audit: AuditTrail;
  clock: Clock;
  ids: IdGenerator;
  config: CompanyConfig;
  ai: AiClassifier;
  correlationId: string;
  flowRunId?: ID;
  approval?: ApprovalDecision;
  /** Data "de hoje" no fuso da empresa. */
  today(): ISODate;
}

export interface SkillDefinition<I = unknown, O = unknown> {
  name: SkillName;
  responsibility: string;
  objective: string;
  inputSchema: ZodType<I>;
  consumes: EventType[];
  publishes: EventType[];
  dataSources: string[];
  execute(ctx: SkillContext, input: I): Promise<SkillResult<O>>;
}

// ---------------------------------------------------------------------------
// Helpers para construir o envelope padrão
// ---------------------------------------------------------------------------

export interface ResultOptions {
  status?: SkillStatus;
  confidence?: number;
  alerts?: SkillAlert[];
  pendingItems?: PendingItem[];
  assumptions?: string[];
  requiresHumanApproval?: boolean;
  dataSources?: string[];
}

export function makeResult<T>(
  skill: SkillName,
  ctx: SkillContext,
  data: T,
  options: ResultOptions = {}
): SkillResult<T> {
  const alerts = options.alerts ?? [];
  const defaultStatus: SkillStatus = alerts.some((a) => a.severity !== "info")
    ? "warning"
    : "success";
  return {
    skill,
    status: options.status ?? defaultStatus,
    confidence: options.confidence ?? 1.0,
    data,
    alerts,
    pending_items: options.pendingItems ?? [],
    assumptions: options.assumptions ?? [],
    requires_human_approval: options.requiresHumanApproval ?? false,
    audit: {
      execution_id: ctx.ids.next("exec"),
      timestamp: ctx.clock.now().toISOString(),
      data_sources: options.dataSources ?? [],
    },
  };
}

export function errorResult(
  skill: SkillName,
  ctx: SkillContext,
  code: string,
  message: string
): SkillResult<null> {
  return makeResult<null>(skill, ctx, null, {
    status: "error",
    confidence: 1.0,
    alerts: [{ severity: "critical", code, message }],
  });
}

export function buildContextToday(clock: Clock, config: CompanyConfig): () => ISODate {
  return () => todayInTz(clock.now(), config.timezone);
}

// ---------------------------------------------------------------------------
// Runner: valida entrada, executa, registra SkillExecution e captura erros
// ---------------------------------------------------------------------------

export async function runSkill<I, O>(
  def: SkillDefinition<I, O>,
  ctx: SkillContext,
  rawInput: unknown
): Promise<SkillResult<O | null>> {
  const startedAt = ctx.clock.now().toISOString();
  let result: SkillResult<O | null>;

  const parsed = def.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    result = errorResult(def.name, ctx, "invalid_input", `Entrada inválida: ${detail}`);
  } else {
    try {
      result = await def.execute(ctx, parsed.data);
    } catch (error) {
      if (error instanceof DomainError) {
        result = errorResult(def.name, ctx, error.code, error.message);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        result = errorResult(def.name, ctx, "unexpected_error", `Falha inesperada: ${message}`);
      }
    }
  }

  const action =
    rawInput && typeof rawInput === "object" && "action" in rawInput
      ? String((rawInput as { action: unknown }).action)
      : "default";

  await ctx.repos.skillExecutions.create({
    id: ctx.ids.next("sx"),
    companyId: ctx.companyId,
    flowRunId: ctx.flowRunId,
    skill: def.name,
    action,
    inputHash: hashPayload(rawInput ?? null),
    status: result.status,
    confidence: result.confidence,
    result,
    startedAt,
    finishedAt: ctx.clock.now().toISOString(),
  });

  return result;
}
