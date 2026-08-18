/**
 * Helper compartilhado das páginas para invocar uma skill DIRETAMENTE (leitura).
 * Fluxos com escrita passam SEMPRE pelo orquestrador (container.orchestrator.execute).
 *
 * runSkillWithDeps é separado de runSkillForSession para permitir teste com
 * createTestEnv (sem Next/cookies/container global).
 */

import type { AiClassifier } from "@/core/ai";
import type { AuditTrail } from "@/core/audit";
import type { Clock } from "@/core/clock";
import type { CompanyConfig } from "@/core/config";
import type { Actor, ID } from "@/core/entities";
import type { EventBus } from "@/core/events";
import type { IdGenerator } from "@/core/ids";
import type { SkillRegistry } from "@/core/orchestrator/registry";
import type { Repositories } from "@/core/repositories";
import {
  buildContextToday,
  runSkill,
  type SkillContext,
  type SkillName,
} from "@/core/skill";
import type { SkillResult } from "@/core/types";
import { getContainer } from "@/lib/container";
import type { SessionInfo } from "@/lib/session";

export interface UiSkillDeps {
  repos: Repositories;
  events: EventBus;
  audit: AuditTrail;
  clock: Clock;
  ids: IdGenerator;
  ai: AiClassifier;
  registry: SkillRegistry;
}

export interface UiSkillScope {
  companyId: ID;
  actor: Actor;
  config: CompanyConfig;
}

/** Envelope de erro sintético quando a skill nem está registrada (stub em paralelo). */
function unavailableResult(
  skillName: string,
  deps: UiSkillDeps,
  message: string
): SkillResult<null> {
  return {
    skill: skillName,
    status: "error",
    confidence: 1.0,
    data: null,
    alerts: [{ severity: "critical", code: "skill_unavailable", message }],
    pending_items: [],
    assumptions: [],
    requires_human_approval: false,
    audit: {
      execution_id: deps.ids.next("exec"),
      timestamp: deps.clock.now().toISOString(),
      data_sources: [],
    },
  };
}

/**
 * Monta o SkillContext (correlationId próprio da UI) e executa via runSkill.
 * Nunca lança por skill ausente/quebrada: devolve SkillResult com status "error"
 * para a página renderizar "Skill em implementação" sem quebrar.
 */
export async function runSkillWithDeps<T = unknown>(
  deps: UiSkillDeps,
  scope: UiSkillScope,
  skillName: SkillName,
  input: unknown
): Promise<SkillResult<T | null>> {
  if (!deps.registry.has(skillName)) {
    return unavailableResult(
      skillName,
      deps,
      `Skill "${skillName}" ainda não registrada.`
    ) as SkillResult<T | null>;
  }
  const ctx: SkillContext = {
    companyId: scope.companyId,
    actor: scope.actor,
    repos: deps.repos,
    events: deps.events,
    audit: deps.audit,
    clock: deps.clock,
    ids: deps.ids,
    config: scope.config,
    ai: deps.ai,
    correlationId: deps.ids.next("ui"),
    today: buildContextToday(deps.clock, scope.config),
  };
  try {
    return (await runSkill(deps.registry.get(skillName), ctx, input)) as SkillResult<T | null>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableResult(skillName, deps, message) as SkillResult<T | null>;
  }
}

/** Invocação direta de skill a partir de uma página autenticada (Server Component). */
export async function runSkillForSession<T = unknown>(
  session: SessionInfo,
  skillName: SkillName,
  input: unknown
): Promise<SkillResult<T | null>> {
  const container = await getContainer();
  return runSkillWithDeps<T>(
    container,
    { companyId: session.company.id, actor: session.actor, config: session.config },
    skillName,
    input
  );
}
