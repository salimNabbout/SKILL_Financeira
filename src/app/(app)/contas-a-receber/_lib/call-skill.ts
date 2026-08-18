/**
 * Invocação direta de skill fora de fluxo do orquestrador (leituras e ações
 * que não possuem fluxo dedicado). Monta o SkillContext a partir da sessão e
 * do container — mesma composição usada pelo orquestrador, com correlationId
 * próprio. A execução passa por runSkill (validação Zod + SkillExecution).
 */

import { getContainer } from "@/lib/container";
import type { SessionInfo } from "@/lib/session";
import { todayInTz } from "@/core/dates";
import { runSkill, type SkillContext, type SkillName } from "@/core/skill";
import type { SkillResult } from "@/core/types";

export async function callSkill<T = unknown>(
  session: SessionInfo,
  skill: SkillName,
  input: unknown
): Promise<SkillResult<T | null>> {
  const container = await getContainer();
  const ctx: SkillContext = {
    companyId: session.company.id,
    actor: session.actor,
    repos: container.repos,
    events: container.events,
    audit: container.audit,
    clock: container.clock,
    ids: container.ids,
    config: session.config,
    ai: container.ai,
    correlationId: container.ids.next("corr"),
    today: () => todayInTz(container.clock.now(), session.config.timezone),
  };
  return (await runSkill(container.registry.get(skill), ctx, input)) as SkillResult<T | null>;
}
