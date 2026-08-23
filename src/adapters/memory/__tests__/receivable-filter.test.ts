import { describe, expect, it } from "vitest";
import type { Receivable } from "@/core/entities";
import { MemoryDb } from "../db";
import { createMemoryRepositories } from "../repos";

const CO = "co_test";

function receivable(
  over: Partial<Receivable> & { id: string; customerId: string; dueDate: string }
): Receivable {
  return {
    companyId: CO,
    description: "Título",
    issueDate: "2026-01-01",
    amountCents: 10_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: over.id,
    createdBy: "usr_1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** Cenário: 2 clientes, vencimentos em maio e junho, um cancelado. */
function seed() {
  const db = new MemoryDb();
  db.receivables.push(
    receivable({ id: "r1", customerId: "cus_a", dueDate: "2026-05-01", status: "open" }),
    receivable({ id: "r2", customerId: "cus_a", dueDate: "2026-05-04", status: "received" }),
    receivable({ id: "r3", customerId: "cus_b", dueDate: "2026-05-20", status: "open" }),
    receivable({ id: "r4", customerId: "cus_a", dueDate: "2026-06-10", status: "open" }),
    receivable({ id: "r5", customerId: "cus_b", dueDate: "2026-06-15", status: "canceled" })
  );
  return createMemoryRepositories(db).receivables;
}

describe("receivables.listPage — filtros aplicados no banco (total reflete o filtro)", () => {
  it("filtra por cliente", async () => {
    const page = await seed().listPage(CO, { customerId: "cus_a" });
    expect(page.total).toBe(3); // r1, r2, r4
    expect(page.items.every((r) => r.customerId === "cus_a")).toBe(true);
  });

  it("filtra por intervalo de vencimento (inclusivo)", async () => {
    const page = await seed().listPage(CO, { dueFrom: "2026-05-01", dueTo: "2026-05-31" });
    expect(page.total).toBe(3); // r1, r2, r3
    expect(page.items.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("dueFrom inclui o limite inferior e dueTo o superior", async () => {
    const page = await seed().listPage(CO, { dueFrom: "2026-05-04", dueTo: "2026-05-20" });
    expect(page.total).toBe(2); // r2 (05-04) e r3 (05-20), ambos nos limites
  });

  it("combina cliente + intervalo + statuses", async () => {
    // cus_a, maio, apenas 'open' → só r1 (r2 é received, r4 é junho).
    const page = await seed().listPage(CO, {
      customerId: "cus_a",
      dueFrom: "2026-05-01",
      dueTo: "2026-05-31",
      statuses: ["open"],
    });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe("r1");
  });

  it("total reflete o filtro mesmo com paginação (limit menor que o total)", async () => {
    const page = await seed().listPage(CO, { customerId: "cus_a", offset: 0, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  it("sem filtros retorna todos", async () => {
    const page = await seed().listPage(CO, {});
    expect(page.total).toBe(5);
  });
});
