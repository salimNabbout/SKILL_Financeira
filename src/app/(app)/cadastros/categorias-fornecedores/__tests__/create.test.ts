import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { addSupplierCategory } from "../_lib/create";

describe("addSupplierCategory", () => {
  it("cria a categoria em Title Case", async () => {
    const env = createTestEnv();
    const result = await addSupplierCategory(env, env.company.id, "material de escritório");
    expect(result.created).toBe(true);
    expect(result.category.name).toBe("Material De Escritório");

    const all = await env.repos.supplierCategories.listAll(env.company.id);
    expect(all.map((c) => c.name)).toEqual(["Material De Escritório"]);
  });

  it("é idempotente por nome (não duplica, ignorando caixa)", async () => {
    const env = createTestEnv();
    await addSupplierCategory(env, env.company.id, "Serviços");
    const second = await addSupplierCategory(env, env.company.id, "serviços");
    expect(second.created).toBe(false);
    expect(await env.repos.supplierCategories.listAll(env.company.id)).toHaveLength(1);
  });

  it("rejeita nome vazio", async () => {
    const env = createTestEnv();
    await expect(addSupplierCategory(env, env.company.id, "   ")).rejects.toThrow(/nome/i);
  });
});
