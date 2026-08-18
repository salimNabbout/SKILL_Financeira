import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { IdGenerator } from "@/core/ids";
import { SkillRegistry } from "@/core/orchestrator/registry";
import { buildRegistry } from "@/skills";
import { parseBudgetCsv } from "../../orcamento/csv";
import { runSkillWithDeps, type UiSkillDeps, type UiSkillScope } from "../run-skill";

function makeDeps(env: TestEnv, registry: SkillRegistry): { deps: UiSkillDeps; prefixes: string[] } {
  const prefixes: string[] = [];
  const ids: IdGenerator = {
    next: (prefix: string) => {
      prefixes.push(prefix);
      return env.ids.next(prefix);
    },
  };
  return {
    deps: {
      repos: env.repos,
      events: env.events,
      audit: env.audit,
      clock: env.clock,
      ids,
      ai: env.ai,
      registry,
    },
    prefixes,
  };
}

function scopeOf(env: TestEnv): UiSkillScope {
  return { companyId: env.company.id, actor: env.actorFor("analyst"), config: env.config };
}

describe("runSkillWithDeps", () => {
  it("caminho feliz: executa skill de leitura com correlationId da UI e registra execução", async () => {
    const env = createTestEnv();
    const { deps, prefixes } = makeDeps(env, buildRegistry());

    const result = await runSkillWithDeps<{ totals?: { availableCents?: number } }>(
      deps,
      scopeOf(env),
      "tesouraria_fluxo_caixa",
      { action: "cash_position" }
    );

    expect(result.skill).toBe("tesouraria_fluxo_caixa");
    expect(result.status).not.toBe("error");
    expect(result.confidence).toBeGreaterThan(0);
    expect(typeof result.data?.totals?.availableCents).toBe("number");
    // correlationId próprio da UI foi gerado
    expect(prefixes).toContain("ui");
    // execução registrada (SkillExecution)
    const executions = await env.repos.skillExecutions.list(env.company.id);
    expect(executions.some((e) => e.skill === "tesouraria_fluxo_caixa" && e.action === "cash_position")).toBe(true);
  });

  it("entrada inválida devolve envelope de erro (invalid_input), sem lançar", async () => {
    const env = createTestEnv();
    const { deps } = makeDeps(env, buildRegistry());

    const result = await runSkillWithDeps(deps, scopeOf(env), "tesouraria_fluxo_caixa", {
      action: "acao_inexistente",
    });

    expect(result.status).toBe("error");
    expect(result.data).toBeNull();
    expect(result.alerts[0]?.code).toBe("invalid_input");
  });

  it("skill não registrada devolve envelope de erro skill_unavailable (página não quebra)", async () => {
    const env = createTestEnv();
    const { deps } = makeDeps(env, new SkillRegistry());

    const result = await runSkillWithDeps(deps, scopeOf(env), "relatorios_gerenciais", {
      action: "daily_summary",
    });

    expect(result.status).toBe("error");
    expect(result.alerts[0]?.code).toBe("skill_unavailable");
    expect(result.requires_human_approval).toBe(false);
  });

  it("integração orçamento: CSV do formulário → upsert_budget idempotente → variance_report", async () => {
    const env = createTestEnv();
    const { deps } = makeDeps(env, buildRegistry());
    const scope = scopeOf(env);

    await env.repos.categories.create({
      id: "cat_pessoal",
      companyId: env.company.id,
      name: "Pessoal e encargos",
      kind: "expense",
      dreGroup: "despesas_operacionais",
      active: true,
    });

    const csv = "cat_pessoal;2026-01;12.500,00\ncat_pessoal;2026-02;10000";
    const parsed = parseBudgetCsv(csv);
    expect(parsed.errors).toEqual([]);

    const input = {
      action: "upsert_budget",
      name: "Orçamento 2026",
      year: 2026,
      lines: parsed.lines,
    };
    const first = await runSkillWithDeps(deps, scope, "orcamento_planejamento", input);
    expect(first.status).not.toBe("error");

    // Idempotência: repetir a mesma ação não duplica o orçamento.
    const second = await runSkillWithDeps(deps, scope, "orcamento_planejamento", input);
    expect(second.status).not.toBe("error");
    const budgets = await env.repos.budgets.listAll(env.company.id);
    expect(budgets).toHaveLength(1);

    const lines = await env.repos.budgetLines.listByBudget(budgets[0].id);
    const jan = lines.find((l) => l.period === "2026-01");
    expect(jan?.amountCents).toBe(1_250_000); // R$ 12.500,00 exatos, em centavos

    const variance = await runSkillWithDeps<{
      totals?: { budgetedCents?: number };
    }>(deps, scope, "orcamento_planejamento", { action: "variance_report", period: "2026-01" });
    expect(variance.status).not.toBe("error");
    expect(variance.data?.totals?.budgetedCents).toBe(1_250_000);
  });
});
