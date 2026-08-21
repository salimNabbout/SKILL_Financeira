import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import type { Payable, Supplier } from "@/core/entities";
import { deleteSupplierByName } from "../_lib/delete";

function seedSupplier(env: ReturnType<typeof createTestEnv>, over: Partial<Supplier> = {}): Supplier {
  const now = env.clock.now().toISOString();
  const s: Supplier = {
    id: over.id ?? "sup_1",
    companyId: env.company.id,
    name: over.name ?? "FORNECEDOR ALFA",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.suppliers.push(s);
  return s;
}

function seedPayable(env: ReturnType<typeof createTestEnv>, supplierId: string): Payable {
  const now = env.clock.now().toISOString();
  const p: Payable = {
    id: "payb_1",
    companyId: env.company.id,
    supplierId,
    description: "Título",
    issueDate: "2026-07-01",
    dueDate: "2026-07-10",
    amountCents: 10000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: "k",
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  };
  env.db.payables.push(p);
  return p;
}

describe("deleteSupplierByName", () => {
  it("exclui o fornecedor quando não há títulos a pagar vinculados", async () => {
    const env = createTestEnv();
    seedSupplier(env, { name: "FORNECEDOR ALFA" });

    await deleteSupplierByName(env, env.company.id, "fornecedor alfa");

    expect(await env.repos.suppliers.listAll(env.company.id)).toHaveLength(0);
  });

  it("recusa a exclusão quando há títulos a pagar vinculados", async () => {
    const env = createTestEnv();
    const s = seedSupplier(env, { name: "FORNECEDOR BETA" });
    seedPayable(env, s.id);

    await expect(deleteSupplierByName(env, env.company.id, "FORNECEDOR BETA")).rejects.toThrow(
      /título|vinculad|pagar/i
    );
    // Não foi removido.
    expect(await env.repos.suppliers.listAll(env.company.id)).toHaveLength(1);
  });

  it("erro claro quando o fornecedor não existe", async () => {
    const env = createTestEnv();
    await expect(deleteSupplierByName(env, env.company.id, "Inexistente")).rejects.toThrow(
      /não encontrado|inexistente/i
    );
  });
});
