import { describe, expect, it } from "vitest";
import { MemoryDb } from "../db";
import { createMemoryRepositories } from "../repos";

function makeCategory(id: string) {
  return {
    id,
    companyId: "co_1",
    name: `Cat ${id}`,
    kind: "expense" as const,
    dreGroup: "despesas_operacionais" as const,
    active: true,
  };
}

describe("withTransaction (adaptador em memória)", () => {
  it("commita quando o callback conclui", async () => {
    const db = new MemoryDb();
    const repos = createMemoryRepositories(db);

    await repos.withTransaction(async (tx) => {
      await tx.categories.create(makeCategory("cat_1"));
    });

    expect(db.categories.map((c) => c.id)).toEqual(["cat_1"]);
  });

  it("faz rollback de TODAS as escritas quando o callback lança", async () => {
    const db = new MemoryDb();
    const repos = createMemoryRepositories(db);
    await repos.categories.create(makeCategory("cat_pre")); // estado anterior

    await expect(
      repos.withTransaction(async (tx) => {
        await tx.categories.create(makeCategory("cat_novo"));
        expect(db.categories.map((c) => c.id).sort()).toEqual(["cat_novo", "cat_pre"]);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // O 'cat_novo' foi desfeito; só o estado anterior permanece.
    expect(db.categories.map((c) => c.id)).toEqual(["cat_pre"]);
  });

  it("propaga o valor de retorno do callback", async () => {
    const db = new MemoryDb();
    const repos = createMemoryRepositories(db);
    const result = await repos.withTransaction(async () => 42);
    expect(result).toBe(42);
  });
});
