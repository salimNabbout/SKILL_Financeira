/**
 * Reaper de flowRuns presos: um fluxo que travou no meio de um passo (crash do
 * processo antes de concluir/suspender) fica em status "running" para sempre,
 * sem ninguém para retomá-lo. Este varredor marca como "failed" os "running"
 * antigos, liberando o operador para reprocessar.
 *
 * NÃO toca em "awaiting_approval" (esperam legitimamente por decisão humana) nem
 * em fluxos já terminais. É idempotente e seguro para rodar periodicamente.
 */

import type { AuditTrail } from "../audit";
import type { Actor, ID } from "../entities";
import type { Repositories } from "../repositories";

/** Mesmo ator de sistema que o scheduler usa (scripts/scheduler.ts). */
const REAPER_ACTOR: Actor = { type: "system", id: "scheduler" };

export interface ReapOptions {
  /** Idade mínima (ms) desde updatedAt para considerar um "running" preso. */
  olderThanMs: number;
}

/**
 * Marca como "failed" os flowRuns "running" da empresa parados há mais que o
 * limite. Devolve quantos foram recuperados. `now` é o instante corrente (ms).
 */
export async function reapStuckFlowRuns(
  repos: Repositories,
  companyId: ID,
  now: number,
  options: ReapOptions,
  audit?: AuditTrail
): Promise<number> {
  const all = await repos.flowRuns.listAll(companyId);
  let reaped = 0;
  for (const flowRun of all) {
    if (flowRun.status !== "running") continue;
    const age = now - new Date(flowRun.updatedAt).getTime();
    if (age < options.olderThanMs) continue;
    const before = { ...flowRun };
    const after = {
      ...flowRun,
      status: "failed" as const,
      updatedAt: new Date(now).toISOString(),
    };
    await repos.flowRuns.update(after);
    // running → failed é uma mudança de estado feita por ninguém: sem registro,
    // um fluxo "que falhou sozinho" não tem como ser explicado depois.
    await audit?.record(companyId, {
      actor: REAPER_ACTOR,
      action: "flow.reaped",
      entityType: "flow_run",
      entityId: flowRun.id,
      before,
      after,
    });
    reaped += 1;
  }
  return reaped;
}
