import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import type { Supplier } from "@/core/entities";
import { updateSupplierFields } from "../_lib/update";

function seed(env: ReturnType<typeof createTestEnv>): Supplier {
  const now = env.clock.now().toISOString();
  const s: Supplier = {
    id: "sup_1",
    companyId: env.company.id,
    name: "FORNECEDOR ALFA",
    document: "11.111.111/0001-11",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  env.db.suppliers.push(s);
  return s;
}

describe("updateSupplierFields", () => {
  it("atualiza os campos, normalizando nome (maiúsculas) e categoria (Title Case)", async () => {
    const env = createTestEnv();
    seed(env);

    const updated = await updateSupplierFields(env, env.company.id, "sup_1", {
      name: "fornecedor alfa renomeado",
      document: "22.222.222/0001-22",
      email: "novo@alfa.com",
      costClassification: "variable",
      category: "material de limpeza",
    });

    expect(updated.name).toBe("FORNECEDOR ALFA RENOMEADO");
    expect(updated.document).toBe("22.222.222/0001-22");
    expect(updated.email).toBe("novo@alfa.com");
    expect(updated.costClassification).toBe("variable");
    expect(updated.category).toBe("Material De Limpeza");

    const stored = await env.repos.suppliers.getById(env.company.id, "sup_1");
    expect(stored?.name).toBe("FORNECEDOR ALFA RENOMEADO");
  });

  it("erro quando o fornecedor não existe", async () => {
    const env = createTestEnv();
    await expect(
      updateSupplierFields(env, env.company.id, "inexistente", { name: "X" })
    ).rejects.toThrow(/não encontrado/i);
  });
});
