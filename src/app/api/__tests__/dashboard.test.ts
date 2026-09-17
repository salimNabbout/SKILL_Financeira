/**
 * Endpoint do Painel por Período — parsing da query string, padrões e erros,
 * executando a skill real de relatórios sobre o adaptador em memória.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { ValidationError } from "@/core/errors";
import { buildRegistry } from "@/skills";
import type { PeriodPanelData } from "@/skills/relatorios";
import type { ApiDeps, ApiSession } from "../_lib/handlers";
import { getPeriodPanel, periodPanelQuerySchema, toPeriodPanelInput } from "../_lib/dashboard";

function depsOf(env: TestEnv): ApiDeps {
  const registry = buildRegistry();
  return {
    repos: env.repos,
    events: env.events,
    audit: env.audit,
    clock: env.clock,
    ids: env.ids,
    ai: env.ai,
    integrations: env.integrations,
    registry,
    orchestrator: env.orchestrator(registry),
  };
}

function sessionOf(env: TestEnv): ApiSession {
  const user = env.users.admin;
  return {
    user,
    membership: {
      id: "mem_admin",
      userId: user.id,
      companyId: env.company.id,
      role: "admin",
      approvalLimitCents: null,
    },
    company: env.company,
    config: env.config,
    actor: env.actorFor("admin"),
  };
}

describe("Painel por Período — query string", () => {
  it("padrão: sem parâmetros usa ano e mês de hoje, dia 1 até o último dia", () => {
    expect(toPeriodPanelInput({}, "2026-09-17")).toEqual({
      action: "period_panel",
      year: 2026,
      month: 9,
      dayFrom: 1,
      dayTo: 31,
      costCenterId: undefined,
      category: undefined,
    });
  });

  it("mes=todos vira ano inteiro; números chegam como string e são convertidos", () => {
    const q = periodPanelQuerySchema.parse({ ano: "2025", mes: "todos", cc: "cc_1", cat: "Aluguel" });
    expect(toPeriodPanelInput(q, "2026-09-17")).toEqual({
      action: "period_panel",
      year: 2025,
      costCenterId: "cc_1",
      category: "Aluguel",
    });
    const q2 = periodPanelQuerySchema.parse({ ano: "2026", mes: "2", de: "5", ate: "12" });
    expect(toPeriodPanelInput(q2, "2026-09-17")).toMatchObject({ year: 2026, month: 2, dayFrom: 5, dayTo: 12 });
  });

  it("valores inválidos são rejeitados (mês 13, dia 0, ano não numérico)", () => {
    expect(periodPanelQuerySchema.safeParse({ mes: "13" }).success).toBe(false);
    expect(periodPanelQuerySchema.safeParse({ de: "0" }).success).toBe(false);
    expect(periodPanelQuerySchema.safeParse({ ano: "abc" }).success).toBe(false);
  });
});

describe("Painel por Período — handler", () => {
  it("executa a skill com os padrões e devolve o envelope com data_sources e suposições", async () => {
    const env = createTestEnv(); // hoje = 2026-08-18
    const res = await getPeriodPanel(depsOf(env), sessionOf(env), {});
    expect(res.status).toBe("success");
    const data = res.data as PeriodPanelData;
    expect(data.period).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(data.totals.paidCents).toBe(0);
    expect(res.audit.data_sources).toEqual(["payments", "payables", "receipts", "cost_centers"]);
    expect(res.assumptions.length).toBeGreaterThan(0);
  });

  it("query inválida vira ValidationError (400) e dia inicial > final também", async () => {
    const env = createTestEnv();
    await expect(getPeriodPanel(depsOf(env), sessionOf(env), { mes: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(getPeriodPanel(depsOf(env), sessionOf(env), { de: "20", ate: "10" })).rejects.toThrow(/Dia inicial/);
  });
});
