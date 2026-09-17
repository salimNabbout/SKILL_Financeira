import { describe, expect, it } from "vitest";
import { MemoryDb } from "@/adapters/memory/db";
import { createMemoryRepositories } from "@/adapters/memory/repos";
import type { Payable, RecurringTemplate, Supplier, SupplierCategory } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import {
  countSupplierCategoryLinks,
  reactivateSupplierCategory,
  removeSupplierCategory,
} from "../_lib/delete";

const CO = "co_test";
const AGORA = "2026-09-17T12:00:00.000Z";

function categoria(id: string, name: string, active = true): SupplierCategory {
  return { id, companyId: CO, name, active, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
function fornecedor(id: string, category?: string): Supplier {
  return { id, companyId: CO, name: `Fornecedor ${id}`, category, active: true, createdAt: AGORA, updatedAt: AGORA };
}
function recorrencia(id: string, category?: string): RecurringTemplate {
  return {
    id,
    companyId: CO,
    kind: "payable",
    counterpartyId: "sup_1",
    description: `Recorrência ${id}`,
    amountCents: 10_000,
    dueDay: 5,
    category,
    startDate: "2026-01-01",
    status: "active",
    createdBy: "usr_1",
    createdAt: AGORA,
    updatedAt: AGORA,
  };
}
function titulo(id: string, supplierCategory?: string): Payable {
  return {
    id,
    companyId: CO,
    supplierId: "sup_1",
    description: id,
    issueDate: "2026-08-01",
    dueDate: "2026-09-30",
    amountCents: 1_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    supplierCategory,
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr_1",
    createdAt: AGORA,
    updatedAt: AGORA,
  };
}

function cenario() {
  const db = new MemoryDb();
  db.supplierCategories.push(categoria("cat_livre", "Sem Uso"), categoria("cat_usada", "Serviços"), categoria("cat_off", "Antiga", false));
  db.suppliers.push(fornecedor("sup_1", "Serviços"), fornecedor("sup_2", "serviços"), fornecedor("sup_3", undefined));
  db.recurringTemplates.push(recorrencia("rec_1", "Serviços"));
  db.payables.push(titulo("pay_1", "Serviços"), titulo("pay_2", "Outra"), titulo("pay_3", "Antiga"));
  const repos = createMemoryRepositories(db);
  return { db, deps: { repos } };
}

describe("countSupplierCategoryLinks", () => {
  it("conta fornecedores, recorrências e títulos que usam o nome, ignorando caixa", async () => {
    const { deps } = cenario();
    expect(await countSupplierCategoryLinks(deps, CO, "Serviços")).toEqual({
      suppliers: 2,
      recurringTemplates: 1,
      payables: 1,
      total: 4,
    });
    expect((await countSupplierCategoryLinks(deps, CO, "Sem Uso")).total).toBe(0);
  });
});

describe("removeSupplierCategory", () => {
  it("sem vínculos: exclui a categoria de vez", async () => {
    const { db, deps } = cenario();
    const r = await removeSupplierCategory(deps, CO, "cat_livre", AGORA);
    expect(r.mode).toBe("deleted");
    expect(r.before.name).toBe("Sem Uso");
    expect(db.supplierCategories.map((c) => c.id)).toEqual(["cat_usada", "cat_off"]);
  });

  it("com vínculos: desativa (não apaga) e devolve a contagem; fornecedores, recorrências e títulos ficam intactos", async () => {
    const { db, deps } = cenario();
    const r = await removeSupplierCategory(deps, CO, "cat_usada", AGORA);
    expect(r.mode).toBe("deactivated");
    if (r.mode !== "deactivated") throw new Error("esperado desativação");
    expect(r.unchanged).toBe(false);
    expect(r.links.total).toBe(4);
    expect(r.before.active).toBe(true);
    expect(r.after).toMatchObject({ id: "cat_usada", active: false, updatedAt: AGORA });
    expect(db.supplierCategories.find((c) => c.id === "cat_usada")?.active).toBe(false);
    expect(db.suppliers.filter((s) => (s.category ?? "").toLowerCase() === "serviços")).toHaveLength(2);
    expect(db.payables.find((p) => p.id === "pay_1")?.supplierCategory).toBe("Serviços");
  });

  it("já inativa e ainda referenciada: idempotente (unchanged)", async () => {
    const { deps } = cenario();
    const r = await removeSupplierCategory(deps, CO, "cat_off", AGORA);
    expect(r.mode).toBe("deactivated");
    if (r.mode !== "deactivated") throw new Error("esperado desativação");
    expect(r.unchanged).toBe(true);
  });

  it("categoria inexistente: not_found", async () => {
    const { deps } = cenario();
    await expect(removeSupplierCategory(deps, CO, "cat_x", AGORA)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reactivateSupplierCategory", () => {
  it("reativa uma inativa e é idempotente para uma ativa", async () => {
    const { db, deps } = cenario();
    const r = await reactivateSupplierCategory(deps, CO, "cat_off", AGORA);
    expect(r.unchanged).toBe(false);
    expect(r.after.active).toBe(true);
    expect(db.supplierCategories.find((c) => c.id === "cat_off")?.active).toBe(true);
    expect((await reactivateSupplierCategory(deps, CO, "cat_usada", AGORA)).unchanged).toBe(true);
  });
});
