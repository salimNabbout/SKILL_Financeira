import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@/core/entities";
import { MemoryDb } from "../db";
import { createMemoryRepositories } from "../repos";

const CO = "co_test";

function rec(over: Partial<AuditRecord> & { seq: number }): AuditRecord {
  return {
    id: `a${over.seq}`,
    companyId: CO,
    actorType: "user",
    actorId: "usr_a",
    action: "payable.created",
    entityType: "payable",
    entityId: "p1",
    timestamp: "2026-08-10T12:00:00.000Z",
    prevHash: "",
    hash: "",
    ...over,
  };
}

/** 5 registros: 2 atores, 3 ações, datas em 3 dias distintos. */
function seed() {
  const db = new MemoryDb();
  db.auditRecords.push(
    rec({ seq: 1, actorId: "usr_a", action: "payable.created", timestamp: "2026-08-10T09:00:00.000Z" }),
    rec({ seq: 2, actorId: "usr_a", action: "payable.updated", timestamp: "2026-08-10T18:00:00.000Z" }),
    rec({ seq: 3, actorId: "usr_b", action: "auth.login", timestamp: "2026-08-15T08:00:00.000Z" }),
    rec({ seq: 4, actorId: "usr_b", action: "payable.created", timestamp: "2026-08-20T23:59:00.000Z" }),
    rec({ seq: 5, actorId: "usr_a", action: "payable.created", timestamp: "2026-08-25T00:00:00.000Z" })
  );
  return createMemoryRepositories(db).audit;
}

describe("audit.listPage — filtros aplicados no banco (total reflete o filtro)", () => {
  it("filtra por ator", async () => {
    const page = await seed().listPage(CO, { actorId: "usr_a" });
    expect(page.total).toBe(3); // seq 1, 2, 5
    expect(page.items.every((r) => r.actorId === "usr_a")).toBe(true);
  });

  it("filtra por ação", async () => {
    const page = await seed().listPage(CO, { action: "payable.created" });
    expect(page.total).toBe(3); // seq 1, 4, 5
  });

  it("filtra por intervalo de datas cobrindo o dia inteiro (inclusive)", async () => {
    // Todo o mês; from inclui 00:00 do dia 10, to inclui 23:59 do dia 25.
    const page = await seed().listPage(CO, { from: "2026-08-10", to: "2026-08-25" });
    expect(page.total).toBe(5);
  });

  it("intervalo de um único dia inclui os registros daquele dia (00:00 e 18:00)", async () => {
    const page = await seed().listPage(CO, { from: "2026-08-10", to: "2026-08-10" });
    expect(page.total).toBe(2); // seq 1 (09:00) e 2 (18:00)
  });

  it("to inclui registro às 23:59 e from inclui registro às 00:00", async () => {
    const soDia20 = await seed().listPage(CO, { from: "2026-08-20", to: "2026-08-20" });
    expect(soDia20.total).toBe(1); // seq 4 às 23:59
    const soDia25 = await seed().listPage(CO, { from: "2026-08-25", to: "2026-08-25" });
    expect(soDia25.total).toBe(1); // seq 5 às 00:00
  });

  it("combina ator + ação + intervalo", async () => {
    // usr_a, payable.created, agosto → seq 1 e 5 (seq 2 é updated).
    const page = await seed().listPage(CO, {
      actorId: "usr_a",
      action: "payable.created",
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(page.total).toBe(2);
    expect(page.items.map((r) => r.seq).sort()).toEqual([1, 5]);
  });

  it("total reflete o filtro mesmo com paginação (limit < total)", async () => {
    const page = await seed().listPage(CO, { actorId: "usr_a", offset: 0, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  it("sem filtros retorna todos", async () => {
    const page = await seed().listPage(CO, {});
    expect(page.total).toBe(5);
  });
});
