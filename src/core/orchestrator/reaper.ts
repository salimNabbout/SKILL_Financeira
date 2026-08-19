/**
 * Reaper de flowRuns presos: um fluxo que travou no meio de um passo (crash do
 * processo antes de concluir/suspender) fica em status "running" para sempre,
 * sem ninguém para retomá-lo. Este varredor marca como "failed" os "running"
 * antigos, liberando o operador para reprocessar.
 *
 * NÃO toca em "awaiting_approval" (esperam legitimamente por decisão humana) nem
 * em fluxos já terminais. É idempotente e seguro para rodar periodicamente.
 */

import type { ID } from "../entities";
import type { Repositories } from "../repositories";

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
  options: ReapOptions
): Promise<number> {
  const all = await repos.flowRuns.listAll(companyId);
  let reaped = 0;
  for (const flowRun of all) {
    if (flowRun.status !== "running") continue;
    const age = now - new Date(flowRun.updatedAt).getTime();
    if (age < options.olderThanMs) continue;
    await repos.flowRuns.update({
      ...flowRun,
      status: "failed",
      updatedAt: new Date(now).toISOString(),
    });
    reaped += 1;
  }
  return reaped;
}
