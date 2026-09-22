import { describe, expect, it } from "vitest";
import { MemoryDb } from "@/adapters/memory/db";
import { createMemoryRepositories } from "@/adapters/memory/repos";
import type { Payable, PayableSubcategory } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import { countPayableSubcategoryLinks, reactivatePayableSubcategory, removePayableSubcategory } from "../_lib/delete";

const CO = "co_test";
const AGORA = "2026-09-22T12:00:00.000Z";

function subcategoria(id: string, name: string, active = true): PayableSubcategory {
  return { id, companyId: CO, name, active, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
function titulo(id: string, subcategory?: string): Payable {
  return {
    id,
    companyId: CO,
    supplierId: "sup_1",
    description: `Título ${id}`,
    issueDate: "2026-09-01",
    dueDate: "2026-09-30",
    amountCents: 10_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    subcategory,
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `k_${id}`,
    createdBy: "usr_1",
    createdAt: AGORA,
    updatedAt: AGORA,
  };
}

function setup(subs: PayableSubcategory[], payables: Payable[] = []) {
  const db = new MemoryDb();
  db.payableSubcategories.push(...subs);
  db.payables.push(...payables);
  return { repos: createMemoryRepositories(db), db };
}

describe("Subcategoria a PAGAR — excluir/desativar", () => {
  it("conta os títulos que usam o nome, ignorando caixa", async () => {
    const { repos } = setup([subcategoria("s1", "Energia Elétrica")], [titulo("p1", "energia elétrica"), titulo("p2", "Água"), titulo("p3")]);
    expect(await countPayableSubcategoryLinks({ repos }, CO, "Energia Elétrica")).toEqual({ payables: 1, total: 1 });
  });

  it("sem vínculos: exclui a subcategoria de vez", async () => {
    const { repos } = setup([subcategoria("s1", "Energia Elétrica")], [titulo("p1", "Água")]);
    const r = await removePayableSubcategory({ repos }, CO, "s1", AGORA);
    expect(r.mode).toBe("deleted");
    expect(await repos.payableSubcategories.listAll(CO)).toHaveLength(0);
  });

  it("com vínculos: desativa (não apaga), devolve a contagem e os títulos ficam intactos", async () => {
    const { repos } = setup([subcategoria("s1", "Energia Elétrica")], [titulo("p1", "Energia Elétrica")]);
    const r = await removePayableSubcategory({ repos }, CO, "s1", AGORA);
    expect(r.mode).toBe("deactivated");
    if (r.mode !== "deactivated") throw new Error("esperado deactivated");
    expect(r.unchanged).toBe(false);
    expect(r.after.active).toBe(false);
    expect(r.after.updatedAt).toBe(AGORA);
    expect(r.links).toEqual({ payables: 1, total: 1 });
    expect((await repos.payables.getById(CO, "p1"))?.subcategory).toBe("Energia Elétrica");
    expect(await repos.payableSubcategories.listAll(CO)).toHaveLength(1);
  });

  it("já inativa e ainda referenciada: idempotente (unchanged)", async () => {
    const { repos } = setup([subcategoria("s1", "Energia Elétrica", false)], [titulo("p1", "Energia Elétrica")]);
    const r = await removePayableSubcategory({ repos }, CO, "s1", AGORA);
    expect(r.mode).toBe("deactivated");
    if (r.mode !== "deactivated") throw new Error("esperado deactivated");
    expect(r.unchanged).toBe(true);
  });

  it("subcategoria inexistente: not_found", async () => {
    const { repos } = setup([]);
    await expect(removePayableSubcategory({ repos }, CO, "nao_existe", AGORA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reativa uma inativa e é idempotente para uma ativa", async () => {
    const { repos } = setup([subcategoria("s1", "Energia Elétrica", false)]);
    const r1 = await reactivatePayableSubcategory({ repos }, CO, "s1", AGORA);
    expect(r1.unchanged).toBe(false);
    expect(r1.after.active).toBe(true);
    const r2 = await reactivatePayableSubcategory({ repos }, CO, "s1", AGORA);
    expect(r2.unchanged).toBe(true);
  });
});
