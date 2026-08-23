import { describe, expect, it } from "vitest";
import type { Payable } from "@/core/entities";
import { MemoryDb } from "../db";
import { createMemoryRepositories } from "../repos";

const CO = "co_test";

function payable(over: Partial<Payable> & { id: string; supplierId: string; dueDate: string }): Payable {
  return {
    companyId: CO,
    description: "Título",
    issueDate: "2026-01-01",
    amountCents: 10_000,
    paidCents: 0,
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

/** Cenário: 2 fornecedores, vencimentos em maio e junho, um cancelado. */
function seed() {
  const db = new MemoryDb();
  db.payables.push(
    payable({ id: "p1", supplierId: "sup_a", dueDate: "2026-05-01", status: "open" }),
    payable({ id: "p2", supplierId: "sup_a", dueDate: "2026-05-04", status: "paid" }),
    payable({ id: "p3", supplierId: "sup_b", dueDate: "2026-05-20", status: "open" }),
    payable({ id: "p4", supplierId: "sup_a", dueDate: "2026-06-10", status: "open" }),
    payable({ id: "p5", supplierId: "sup_b", dueDate: "2026-06-15", status: "canceled" })
  );
  return createMemoryRepositories(db).payables;
}

describe("payables.listPage — filtros aplicados no banco (total reflete o filtro)", () => {
  it("filtra por fornecedor", async () => {
    const page = await seed().listPage(CO, { supplierId: "sup_a" });
    expect(page.total).toBe(3); // p1, p2, p4
    expect(page.items.every((p) => p.supplierId === "sup_a")).toBe(true);
  });

  it("filtra por intervalo de vencimento (inclusivo)", async () => {
    // Todo o mês de maio.
    const page = await seed().listPage(CO, { dueFrom: "2026-05-01", dueTo: "2026-05-31" });
    expect(page.total).toBe(3); // p1, p2, p3
    expect(page.items.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("dueFrom inclui o limite inferior e dueTo o superior", async () => {
    const page = await seed().listPage(CO, { dueFrom: "2026-05-04", dueTo: "2026-05-20" });
    expect(page.total).toBe(2); // p2 (05-04) e p3 (05-20), ambos nos limites
  });

  it("combina fornecedor + intervalo + statuses", async () => {
    // sup_a, maio, apenas 'open' → só p1 (p2 é paid, p4 é junho).
    const page = await seed().listPage(CO, {
      supplierId: "sup_a",
      dueFrom: "2026-05-01",
      dueTo: "2026-05-31",
      statuses: ["open"],
    });
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe("p1");
  });

  it("total reflete o filtro mesmo com paginação (limit menor que o total)", async () => {
    // sup_a tem 3 títulos; pedindo página de 2, total continua 3.
    const page = await seed().listPage(CO, { supplierId: "sup_a", offset: 0, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  it("sem filtros retorna todos", async () => {
    const page = await seed().listPage(CO, {});
    expect(page.total).toBe(5);
  });
});
