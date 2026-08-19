/**
 * Agendador de rotinas — lógica PURA e determinística (o processo que a executa
 * fica em scripts/scheduler.ts). Duas garantias trabalham juntas:
 *
 * 1. `isDue` decide a elegibilidade (cadência horária/diária no FUSO da
 *    empresa) usando o último disparo conhecido em memória; e
 * 2. a CORREÇÃO não depende dessa memória: cada disparo deriva uma chave de
 *    idempotência do balde de tempo (dia ou dia+hora locais), então reexecutar
 *    após um restart vira replay idempotente no orquestrador — nunca duplica.
 *
 * Agendas são DADOS por empresa (CompanyConfig.schedules), como as demais
 * políticas.
 */

import { hourInTz, todayInTz } from "./dates";
import type { ID } from "./entities";

export type ScheduleCadence = "hourly" | "daily";

export interface ScheduleDefinition {
  /** Identificador estável (compõe a chave de idempotência). */
  id: string;
  /** Fluxo do orquestrador a executar. */
  flow: string;
  cadence: ScheduleCadence;
  /** Cadência diária: hora LOCAL (0–23) a partir da qual o disparo fica elegível. */
  hourLocal?: number;
  enabled: boolean;
  /** Payload base do fluxo (ex.: sinceDays do bank_sync). */
  payload?: Record<string, unknown>;
  /** Expande um disparo por conta bancária ativa (payload ganha bankAccountId). */
  perBankAccount?: boolean;
}

/** Agenda padrão: sincroniza extrato de manhã, resume o dia e roda a régua. */
export const DEFAULT_SCHEDULES: ScheduleDefinition[] = [
  {
    id: "sincronizacao_bancaria",
    flow: "bank_sync",
    cadence: "daily",
    hourLocal: 6,
    enabled: true,
    perBankAccount: true,
  },
  { id: "resumo_diario", flow: "daily_summary", cadence: "daily", hourLocal: 7, enabled: true },
  { id: "regua_cobranca", flow: "dunning_run", cadence: "daily", hourLocal: 8, enabled: true },
];

const HOUR_MS = 60 * 60 * 1000;

/**
 * Elegibilidade do disparo:
 * - hourly: nunca disparou OU passou ≥ 1h do último disparo;
 * - daily: hora local ≥ hourLocal (default 6) E o último disparo foi em uma
 *   DATA local anterior à de hoje.
 */
export function isDue(
  def: ScheduleDefinition,
  nowUtc: Date,
  timezone: string,
  lastRunAtIso?: string
): boolean {
  if (!def.enabled) return false;
  if (def.cadence === "hourly") {
    if (!lastRunAtIso) return true;
    return nowUtc.getTime() - new Date(lastRunAtIso).getTime() >= HOUR_MS;
  }
  const hour = hourInTz(nowUtc, timezone);
  if (hour < (def.hourLocal ?? 6)) return false;
  if (!lastRunAtIso) return true;
  return todayInTz(new Date(lastRunAtIso), timezone) < todayInTz(nowUtc, timezone);
}

/**
 * Chave de idempotência do balde de tempo — estável dentro do dia (daily) ou
 * da hora (hourly) locais: reexecuções no mesmo balde são replay no orquestrador.
 */
export function scheduleIdempotencyKey(
  def: ScheduleDefinition,
  companyId: ID,
  nowUtc: Date,
  timezone: string,
  suffix = ""
): string {
  const date = todayInTz(nowUtc, timezone);
  const bucket =
    def.cadence === "daily" ? date : `${date}T${String(hourInTz(nowUtc, timezone)).padStart(2, "0")}`;
  return `sched:${def.id}:${companyId}:${bucket}${suffix}`;
}

export interface DueJob {
  scheduleId: string;
  flow: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  /** Chave do rastro em memória do último disparo (schedule + conta, se houver). */
  lastRunKey: string;
}

/**
 * Coleta os disparos elegíveis de uma empresa. `lastRuns` é o rastro em
 * memória do processo (chave → ISO do último disparo); a correção final vem da
 * chave de idempotência, não dele.
 */
export function collectDueJobs(params: {
  schedules: ScheduleDefinition[];
  companyId: ID;
  timezone: string;
  nowUtc: Date;
  lastRuns: Map<string, string>;
  activeBankAccountIds: ID[];
}): DueJob[] {
  const { schedules, companyId, timezone, nowUtc, lastRuns, activeBankAccountIds } = params;
  const jobs: DueJob[] = [];
  for (const def of schedules) {
    const targets = def.perBankAccount
      ? activeBankAccountIds.map((id) => ({ suffix: `:${id}`, extra: { bankAccountId: id } }))
      : [{ suffix: "", extra: {} }];
    for (const target of targets) {
      const lastRunKey = `${companyId}:${def.id}${target.suffix}`;
      if (!isDue(def, nowUtc, timezone, lastRuns.get(lastRunKey))) continue;
      jobs.push({
        scheduleId: def.id,
        flow: def.flow,
        payload: { ...(def.payload ?? {}), ...target.extra },
        idempotencyKey: scheduleIdempotencyKey(def, companyId, nowUtc, timezone, target.suffix),
        lastRunKey,
      });
    }
  }
  return jobs;
}
