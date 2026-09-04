import { describe, expect, it, vi } from "vitest";
import { ActivityLog, sanitizeActivityDetails } from "@/core/activity";
import { FixedClock } from "@/core/clock";
import { SequentialIdGenerator } from "@/core/ids";
import { MemoryDb } from "@/adapters/memory/db";
import { createMemoryRepositories } from "@/adapters/memory/repos";

const NOW = "2026-09-04T12:00:00.000Z";

function makeLog() {
  const db = new MemoryDb();
  const repos = createMemoryRepositories(db);
  const log = new ActivityLog(repos.activityEvents, new FixedClock(NOW), new SequentialIdGenerator());
  return { db, repos, log };
}

describe("sanitizeActivityDetails", () => {
  it("mascara valores de chaves sensíveis (senha/password/token/secret/cartão), em qualquer nível", () => {
    const out = sanitizeActivityDetails({
      nome: "Ana",
      senha: "hunter2",
      Password: "x",
      apiToken: "tk_123",
      clientSecret: "s",
      numeroCartao: "4111",
      cartão: "4111",
      aninhado: { tokenDeAcesso: "abc", ok: 1 },
    }) as Record<string, unknown>;
    expect(out.nome).toBe("Ana");
    expect(out.senha).toBe("***");
    expect(out.Password).toBe("***");
    expect(out.apiToken).toBe("***");
    expect(out.clientSecret).toBe("***");
    expect(out.numeroCartao).toBe("***");
    expect(out["cartão"]).toBe("***");
    expect((out.aninhado as Record<string, unknown>).tokenDeAcesso).toBe("***");
    expect((out.aninhado as Record<string, unknown>).ok).toBe(1);
  });

  it("trunca strings longas e limita profundidade e arrays", () => {
    const longa = "x".repeat(500);
    expect((sanitizeActivityDetails(longa) as string).length).toBe(301); // 300 + "…"
    const fundo = { a: { b: { c: { d: { e: "profundo" } } } } };
    const out = sanitizeActivityDetails(fundo) as Record<string, never>;
    expect(JSON.stringify(out)).toContain("***");
    const arr = sanitizeActivityDetails(Array.from({ length: 50 }, (_, i) => i)) as number[];
    expect(arr.length).toBe(20);
  });
});

describe("ActivityLog.record", () => {
  it("grava evento com id gerado, timestamp do relógio e detalhes mascarados", async () => {
    const { db, log } = makeLog();
    await log.record("co_teste", {
      userId: "usr_1",
      origin: "frontend",
      eventType: "clique",
      screen: "/contas-a-pagar",
      label: "Salvar",
      details: { senha: "nunca" },
    });
    expect(db.activityEvents).toHaveLength(1);
    const e = db.activityEvents[0];
    expect(e.id).toBe("act_0001");
    expect(e.companyId).toBe("co_teste");
    expect(e.timestamp).toBe(NOW);
    expect((e.details as Record<string, unknown>).senha).toBe("***");
  });

  it("usa o timestamp do cliente quando plausível e descarta quando fora da janela", async () => {
    const { db, log } = makeLog();
    const recente = "2026-09-04T11:59:00.000Z"; // 1min atrás: aceito
    await log.record("co_teste", { origin: "frontend", eventType: "clique", timestamp: recente });
    await log.record("co_teste", {
      origin: "frontend",
      eventType: "clique",
      timestamp: "2020-01-01T00:00:00.000Z", // relógio quebrado: usa o servidor
    });
    expect(db.activityEvents[0].timestamp).toBe(recente);
    expect(db.activityEvents[1].timestamp).toBe(NOW);
  });

  it("NUNCA lança quando a persistência falha (auditoria não derruba a ação)", async () => {
    const { repos, log } = makeLog();
    const spy = vi
      .spyOn(repos.activityEvents, "append")
      .mockRejectedValue(new Error("banco fora do ar"));
    const silence = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      log.record("co_teste", { origin: "backend", eventType: "requisicao" })
    ).resolves.toBeUndefined();
    spy.mockRestore();
    silence.mockRestore();
  });
});

describe("ActivityEventRepo (memória): filtros e paginação", () => {
  it("filtra por usuário, tipo, origem, período e busca textual; total reflete o filtro", async () => {
    const { repos, log } = makeLog();
    await log.record("co_teste", {
      userId: "usr_a",
      origin: "frontend",
      eventType: "clique",
      screen: "/auditoria",
      label: "Exportar CSV",
    });
    await log.record("co_teste", {
      userId: "usr_b",
      origin: "backend",
      eventType: "requisicao",
      method: "GET",
      path: "/api/v1/payables",
      status: 200,
    });
    await log.record("co_outra", { origin: "frontend", eventType: "clique" });

    const porUsuario = await repos.activityEvents.listPage("co_teste", { userId: "usr_a" });
    expect(porUsuario.total).toBe(1);
    expect(porUsuario.items[0].label).toBe("Exportar CSV");

    const porOrigem = await repos.activityEvents.listPage("co_teste", { origin: "backend" });
    expect(porOrigem.total).toBe(1);
    expect(porOrigem.items[0].path).toBe("/api/v1/payables");

    const busca = await repos.activityEvents.listPage("co_teste", { q: "exportar" });
    expect(busca.total).toBe(1);

    const periodo = await repos.activityEvents.listPage("co_teste", {
      from: "2026-09-05",
      to: "2026-09-06",
    });
    expect(periodo.total).toBe(0);

    const tipos = await repos.activityEvents.listEventTypes("co_teste");
    expect(tipos).toEqual(["clique", "requisicao"]);
  });
});
