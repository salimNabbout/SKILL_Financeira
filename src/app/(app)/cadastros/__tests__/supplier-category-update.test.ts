import { describe, expect, it } from "vitest";
import { MemoryDb } from "@/adapters/memory/db";
import { createMemoryRepositories } from "@/adapters/memory/repos";
import { hasPermission } from "@/core/auth";
import type { RecurringTemplate, Supplier, SupplierCategory } from "@/core/entities";
import { ValidationError } from "@/core/errors";
import { HashChainAuditTrail } from "@/core/audit";
import { SequentialIdGenerator } from "@/core/ids";
import type { Actor } from "@/core/entities";
import { renameSupplierCategory } from "@/app/(app)/cadastros/categorias-fornecedores/_lib/update";

const CO = "co_test";
const AGORA = "2026-08-24T12:00:00.000Z";

const clock = { now: () => new Date(AGORA) };
const ATOR: Actor = { type: "user", id: "usr_admin", role: "admin" };

function categoria(id: string, name: string): SupplierCategory {
  return {
    id,
    companyId: CO,
    name,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fornecedor(id: string, category?: string): Supplier {
  return {
    id,
    companyId: CO,
    name: `Fornecedor ${id}`,
    category,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function recorrencia(id: string, category?: string): RecurringTemplate {
  return {
    id,
    companyId: CO,
    kind: "payable",
    counterpartyId: "sup_1",
    description: `Recorrência ${id}`,
    amountCents: 100_00,
    dueDay: 5,
    category,
    startDate: "2026-01-01",
    status: "active",
    createdBy: "usr_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function cenario() {
  const db = new MemoryDb();
  db.supplierCategories.push(categoria("cat_1", "Serviços"), categoria("cat_2", "Insumos"));
  db.suppliers.push(
    fornecedor("sup_1", "Serviços"),
    fornecedor("sup_2", "Serviços"),
    fornecedor("sup_3", "Insumos"),
    fornecedor("sup_4", undefined)
  );
  db.recurringTemplates.push(recorrencia("rec_1", "Serviços"), recorrencia("rec_2", "Insumos"));
  const repos = createMemoryRepositories(db);
  const audit = new HashChainAuditTrail(repos.audit, clock, new SequentialIdGenerator());
  return { db, deps: { repos, clock, audit } };
}

describe("renameSupplierCategory", () => {
  it("renomeia e propaga o nome novo para fornecedores e recorrências", async () => {
    const { db, deps } = cenario();

    const r = await renameSupplierCategory(deps, CO, "cat_1", "Serviços Terceirizados", ATOR);

    expect(r.semMudanca).toBe(false);
    expect(r.before.name).toBe("Serviços");
    expect(r.after.name).toBe("Serviços Terceirizados");
    expect(r.suppliersAtualizados).toBe(2);
    expect(r.recorrenciasAtualizadas).toBe(1);

    // Nenhum registro fica apontando para o nome antigo.
    expect(db.suppliers.filter((s) => s.category === "Serviços")).toHaveLength(0);
    expect(db.suppliers.filter((s) => s.category === "Serviços Terceirizados")).toHaveLength(2);
    expect(db.recurringTemplates.find((t) => t.id === "rec_1")?.category).toBe(
      "Serviços Terceirizados"
    );

    // Quem usava outra categoria (ou nenhuma) não é tocado.
    expect(db.suppliers.find((s) => s.id === "sup_3")?.category).toBe("Insumos");
    expect(db.suppliers.find((s) => s.id === "sup_4")?.category).toBeUndefined();
    expect(db.recurringTemplates.find((t) => t.id === "rec_2")?.category).toBe("Insumos");
  });

  it("normaliza o nome para Title Case, como no cadastro", async () => {
    const { deps } = cenario();
    const r = await renameSupplierCategory(deps, CO, "cat_1", "  serviços   GERAIS ", ATOR);
    expect(r.after.name).toBe("Serviços Gerais");
  });

  it("recusa nome duplicado, ignorando a caixa", async () => {
    const { db, deps } = cenario();

    await expect(renameSupplierCategory(deps, CO, "cat_1", "insumos", ATOR)).rejects.toThrow(
      ValidationError
    );

    // Nada foi escrito: a categoria e os fornecedores seguem como estavam.
    expect(db.supplierCategories.find((c) => c.id === "cat_1")?.name).toBe("Serviços");
    expect(db.suppliers.filter((s) => s.category === "Serviços")).toHaveLength(2);
  });

  it("aceita renomear para o mesmo nome sem escrever nada", async () => {
    const { db, deps } = cenario();
    const r = await renameSupplierCategory(deps, CO, "cat_1", "Serviços", ATOR);
    expect(r.semMudanca).toBe(true);
    expect(r.suppliersAtualizados).toBe(0);
    expect(db.supplierCategories.find((c) => c.id === "cat_1")?.updatedAt).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  it("recusa nome vazio e categoria inexistente", async () => {
    const { deps } = cenario();
    await expect(renameSupplierCategory(deps, CO, "cat_1", "   ", ATOR)).rejects.toThrow(ValidationError);
    await expect(renameSupplierCategory(deps, CO, "cat_999", "Qualquer", ATOR)).rejects.toThrow(
      ValidationError
    );
  });
});

describe("permissão exigida para renomear (master_data.manage)", () => {
  // A action recusa antes de chamar o núcleo; aqui garantimos que a matriz de
  // papéis é a mesma usada na criação — quem não pode criar não pode renomear.
  it("papéis sem master_data.manage não podem gerenciar cadastros", () => {
    expect(hasPermission("approver", "master_data.manage")).toBe(false);
    expect(hasPermission("accountant", "master_data.manage")).toBe(false);
    expect(hasPermission("viewer", "master_data.manage")).toBe(false);
  });

  it("papéis operacionais podem", () => {
    expect(hasPermission("admin", "master_data.manage")).toBe(true);
    expect(hasPermission("finance_manager", "master_data.manage")).toBe(true);
    expect(hasPermission("finance_analyst", "master_data.manage")).toBe(true);
  });
});
