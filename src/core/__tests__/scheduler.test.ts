import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { buildRegistry } from "@/skills";
import {
  collectDueJobs,
  DEFAULT_SCHEDULES,
  isDue,
  scheduleIdempotencyKey,
  type ScheduleDefinition,
} from "../scheduler";

const TZ = "America/Sao_Paulo"; // UTC-3 nas datas usadas aqui

const DAILY: ScheduleDefinition = {
  id: "sincronizacao_bancaria",
  flow: "bank_sync",
  cadence: "daily",
  hourLocal: 6,
  enabled: true,
  perBankAccount: true,
};

const HOURLY: ScheduleDefinition = {
  id: "de_hora_em_hora",
  flow: "daily_summary",
  cadence: "hourly",
  enabled: true,
};

describe("scheduler / isDue", () => {
  it("daily: só a partir da hora local configurada e uma vez por DIA local", () => {
    // 08:00Z = 05:00 local → antes das 6h.
    expect(isDue(DAILY, new Date("2026-08-18T08:00:00Z"), TZ)).toBe(false);
    // 09:00Z = 06:00 local → elegível (nunca disparou).
    expect(isDue(DAILY, new Date("2026-08-18T09:00:00Z"), TZ)).toBe(true);
    // Já disparou HOJE (07:00 local) → não repete no mesmo dia.
    expect(
      isDue(DAILY, new Date("2026-08-18T15:00:00Z"), TZ, "2026-08-18T10:00:00Z")
    ).toBe(false);
    // Último disparo ONTEM → elegível de novo.
    expect(
      isDue(DAILY, new Date("2026-08-18T15:00:00Z"), TZ, "2026-08-17T10:00:00Z")
    ).toBe(true);
  });

  it("hourly: intervalo mínimo de 1 hora; desabilitado nunca dispara", () => {
    const now = new Date("2026-08-18T15:00:00Z");
    expect(isDue(HOURLY, now, TZ)).toBe(true);
    expect(isDue(HOURLY, now, TZ, "2026-08-18T14:01:00Z")).toBe(false); // 59min
    expect(isDue(HOURLY, now, TZ, "2026-08-18T14:00:00Z")).toBe(true); // 60min
    expect(isDue({ ...HOURLY, enabled: false }, now, TZ)).toBe(false);
    expect(isDue({ ...DAILY, enabled: false }, new Date("2026-08-18T15:00:00Z"), TZ)).toBe(false);
  });
});

describe("scheduler / chave de idempotência por balde de tempo", () => {
  it("daily é estável dentro do dia local; hourly muda a cada hora", () => {
    const morning = new Date("2026-08-18T09:30:00Z");
    const evening = new Date("2026-08-18T22:30:00Z"); // 19:30 local, mesmo dia
    expect(scheduleIdempotencyKey(DAILY, "co_1", morning, TZ)).toBe(
      scheduleIdempotencyKey(DAILY, "co_1", evening, TZ)
    );
    expect(scheduleIdempotencyKey(DAILY, "co_1", morning, TZ)).toBe(
      "sched:sincronizacao_bancaria:co_1:2026-08-18"
    );

    const h1 = scheduleIdempotencyKey(HOURLY, "co_1", new Date("2026-08-18T14:10:00Z"), TZ);
    const h2 = scheduleIdempotencyKey(HOURLY, "co_1", new Date("2026-08-18T15:10:00Z"), TZ);
    expect(h1).not.toBe(h2);
    expect(h1).toBe("sched:de_hora_em_hora:co_1:2026-08-18T11");

    expect(scheduleIdempotencyKey(DAILY, "co_1", morning, TZ, ":ba_1")).toBe(
      "sched:sincronizacao_bancaria:co_1:2026-08-18:ba_1"
    );
  });
});

describe("scheduler / collectDueJobs", () => {
  it("expande por conta bancária ativa e respeita o rastro por conta", () => {
    const now = new Date("2026-08-18T15:00:00Z"); // 12:00 local
    const lastRuns = new Map<string, string>([
      // ba_1 já sincronizou hoje; ba_2 não.
      ["co_1:sincronizacao_bancaria:ba_1", "2026-08-18T09:05:00Z"],
    ]);
    const jobs = collectDueJobs({
      schedules: [DAILY, { id: "resumo_diario", flow: "daily_summary", cadence: "daily", hourLocal: 7, enabled: true }],
      companyId: "co_1",
      timezone: TZ,
      nowUtc: now,
      lastRuns,
      activeBankAccountIds: ["ba_1", "ba_2"],
    });

    expect(jobs.map((j) => `${j.scheduleId}${j.payload.bankAccountId ? `:${j.payload.bankAccountId}` : ""}`)).toEqual([
      "sincronizacao_bancaria:ba_2",
      "resumo_diario",
    ]);
    expect(jobs[0].payload).toEqual({ bankAccountId: "ba_2" });
    expect(jobs[0].idempotencyKey).toBe("sched:sincronizacao_bancaria:co_1:2026-08-18:ba_2");
    expect(jobs[1].flow).toBe("daily_summary");
  });

  it("agenda padrão cobre sincronização, resumo, régua e recorrência — todas diárias", () => {
    expect(DEFAULT_SCHEDULES.map((s) => s.flow)).toEqual([
      "bank_sync",
      "daily_summary",
      "dunning_run",
      "recurring_titles_generate",
    ]);
    expect(DEFAULT_SCHEDULES.every((s) => s.cadence === "daily" && s.enabled)).toBe(true);
  });
});

describe("scheduler / disparo agendado é idempotente no orquestrador", () => {
  it("reexecutar com a MESMA chave (restart no mesmo dia) é replay — nada duplica", async () => {
    const env = createTestEnv();
    const now = env.clock.now().toISOString();
    await env.repos.bankAccounts.create({
      id: "ba_sched",
      companyId: env.company.id,
      name: "Conta Agendada",
      bankCode: "001",
      agency: "0001",
      accountNumberMasked: "***2222",
      type: "checking",
      currency: "BRL",
      openingBalanceCents: 0,
      openingBalanceDate: "2026-01-01",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const orch = env.orchestrator(buildRegistry());
    const actor = { type: "system" as const, id: "scheduler" };
    const key = scheduleIdempotencyKey(DAILY, env.company.id, env.clock.now(), TZ, ":ba_sched");

    const first = await orch.execute({
      flow: "bank_sync",
      companyId: env.company.id,
      actor,
      payload: { bankAccountId: "ba_sched" },
      idempotencyKey: key,
    });
    expect(first.status).toBe("completed");
    const txCount = env.db.bankTransactions.length;
    expect(txCount).toBeGreaterThan(0);

    // "Restart" do agendador no mesmo dia: mesma chave → replay, sem duplicar.
    const second = await orch.execute({
      flow: "bank_sync",
      companyId: env.company.id,
      actor,
      payload: { bankAccountId: "ba_sched" },
      idempotencyKey: key,
    });
    expect(second.idempotent_replay).toBe(true);
    expect(env.db.bankTransactions).toHaveLength(txCount);
  });
});
