import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { addPayableSubcategory } from "../_lib/create";
import { renamePayableSubcategory } from "../_lib/update";

describe("addPayableSubcategory", () => {
  it("cria a subcategoria em Title Case", async () => {
    const env = createTestEnv();
    const result = await addPayableSubcategory(env, env.company.id, "energia elétrica");
    expect(result.created).toBe(true);
    expect(result.subcategory.name).toBe("Energia Elétrica");
    expect(result.subcategory.active).toBe(true);

    const all = await env.repos.payableSubcategories.listAll(env.company.id);
    expect(all.map((s) => s.name)).toEqual(["Energia Elétrica"]);
  });

  it("é idempotente por nome (não duplica, ignorando caixa)", async () => {
    const env = createTestEnv();
    await addPayableSubcategory(env, env.company.id, "Água");
    const second = await addPayableSubcategory(env, env.company.id, "água");
    expect(second.created).toBe(false);
    expect(await env.repos.payableSubcategories.listAll(env.company.id)).toHaveLength(1);
  });

  it("rejeita nome vazio", async () => {
    const env = createTestEnv();
    await expect(addPayableSubcategory(env, env.company.id, "   ")).rejects.toThrow(/nome/i);
  });
});

describe("renamePayableSubcategory", () => {
  it("renomeia em Title Case, é idempotente para o mesmo nome e recusa nome já usado", async () => {
    const env = createTestEnv();
    const { subcategory: a } = await addPayableSubcategory(env, env.company.id, "Energia");
    await addPayableSubcategory(env, env.company.id, "Água");

    const renomeada = await renamePayableSubcategory(env, env.company.id, a.id, "energia elétrica");
    expect(renomeada.semMudanca).toBe(false);
    expect(renomeada.before.name).toBe("Energia");
    expect(renomeada.after.name).toBe("Energia Elétrica");

    const igual = await renamePayableSubcategory(env, env.company.id, a.id, "Energia Elétrica");
    expect(igual.semMudanca).toBe(true);

    await expect(renamePayableSubcategory(env, env.company.id, a.id, "água")).rejects.toThrow(/Já existe/);
    await expect(renamePayableSubcategory(env, env.company.id, "nao_existe", "X")).rejects.toThrow(/não encontrada/);
  });
});
