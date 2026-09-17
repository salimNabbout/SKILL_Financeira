import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Budget, BudgetLine, Category, Payable, Receivable } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import { addReceivableCategory, listReceivableCategories } from "../_lib/create";
import {
  countReceivableCategoryLinks,
  reactivateReceivableCategory,
  removeReceivableCategory,
} from "../_lib/delete";
import { renameReceivableCategory } from "../_lib/update";

function seedCategory(env: TestEnv, over: Partial<Category> & { id: string; name: string }): Category {
  const c: Category = { companyId: env.company.id, kind: "income", dreGroup: "receita_bruta", active: true, ...over };
  env.db.categories.push(c);
  return c;
}

function seedReceivable(env: TestEnv, id: string, categoryId?: string): Receivable {
  const now = env.clock.now().toISOString();
  const r: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: id,
    issueDate: "2026-08-01",
    dueDate: "2026-09-30",
    amountCents: 1_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    categoryId,
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr",
    createdAt: now,
    updatedAt: now,
  };
  env.db.receivables.push(r);
  return r;
}

function seedPayable(env: TestEnv, id: string, categoryId?: string): Payable {
  const now = env.clock.now().toISOString();
  const p: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: id,
    issueDate: "2026-08-01",
    dueDate: "2026-09-30",
    amountCents: 1_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    categoryId,
    installmentNumber: 1,
    installmentCount: 1,
    originKey: id,
    createdBy: "usr",
    createdAt: now,
    updatedAt: now,
  };
  env.db.payables.push(p);
  return p;
}

async function seedBudgetLine(env: TestEnv, categoryId: string): Promise<void> {
  const now = env.clock.now().toISOString();
  const budget: Budget = {
    id: "bud_1",
    companyId: env.company.id,
    name: "Orçamento 2026",
    year: 2026,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await env.repos.budgets.create(budget);
  const line: BudgetLine = { id: "bl_1", budgetId: "bud_1", period: "2026-09", categoryId, amountCents: 100 };
  await env.repos.budgetLines.create(line);
}

describe("Categoria a RECEBER — criação e listagem", () => {
  it("cria categoria de RECEITA em Title Case (grupo receita bruta) e é idempotente por nome, ignorando caixa", async () => {
    const env = createTestEnv();
    const r1 = await addReceivableCategory(env, env.company.id, "venda de serviços");
    expect(r1.created).toBe(true);
    expect(r1.category).toMatchObject({ name: "Venda De Serviços", kind: "income", dreGroup: "receita_bruta", active: true });
    const r2 = await addReceivableCategory(env, env.company.id, "VENDA DE SERVIÇOS");
    expect(r2.created).toBe(false);
    expect(r2.category.id).toBe(r1.category.id);
    await expect(addReceivableCategory(env, env.company.id, "  ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("a lista traz só categorias de receita — as de despesa (cadastro DRE) ficam fora", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c_in", name: "Vendas" });
    seedCategory(env, { id: "c_out", name: "Aluguel", kind: "expense", dreGroup: "despesas_operacionais" });
    expect((await listReceivableCategories(env, env.company.id)).map((c) => c.id)).toEqual(["c_in"]);
  });
});

describe("Categoria a RECEBER — editar", () => {
  it("renomeia (Title Case), rejeita duplicata entre as de receita e é idempotente para o mesmo nome", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c1", name: "Vendas" });
    seedCategory(env, { id: "c2", name: "Serviços" });
    const r = await renameReceivableCategory(env, env.company.id, "c1", "vendas online");
    expect(r.semMudanca).toBe(false);
    expect(r.after.name).toBe("Vendas Online");
    expect((await env.repos.categories.getById(env.company.id, "c1"))?.name).toBe("Vendas Online");
    expect((await renameReceivableCategory(env, env.company.id, "c1", "Vendas Online")).semMudanca).toBe(true);
    await expect(renameReceivableCategory(env, env.company.id, "c1", "serviços")).rejects.toThrow(/Já existe/);
  });

  it("categoria de despesa ou inexistente não é editável por esta tela", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c_out", name: "Aluguel", kind: "expense", dreGroup: "despesas_operacionais" });
    await expect(renameReceivableCategory(env, env.company.id, "c_out", "X")).rejects.toBeInstanceOf(NotFoundError);
    await expect(renameReceivableCategory(env, env.company.id, "nada", "X")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("Categoria a RECEBER — excluir e reativar", () => {
  it("conta vínculos por id em títulos a receber, a pagar e linhas de orçamento", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c1", name: "Vendas" });
    seedReceivable(env, "r1", "c1");
    seedReceivable(env, "r2", "c1");
    seedReceivable(env, "r3", undefined);
    seedPayable(env, "p1", "c1");
    await seedBudgetLine(env, "c1");
    expect(await countReceivableCategoryLinks(env, env.company.id, "c1")).toEqual({
      receivables: 2,
      payables: 1,
      budgetLines: 1,
      total: 4,
    });
  });

  it("sem vínculos: exclui de vez", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c1", name: "Vendas" });
    const r = await removeReceivableCategory(env, env.company.id, "c1");
    expect(r.mode).toBe("deleted");
    expect(await env.repos.categories.getById(env.company.id, "c1")).toBeNull();
  });

  it("com vínculos: desativa (idempotente) e os títulos continuam apontando para ela; reativar volta", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c1", name: "Vendas" });
    seedReceivable(env, "r1", "c1");
    const r = await removeReceivableCategory(env, env.company.id, "c1");
    expect(r.mode).toBe("deactivated");
    if (r.mode !== "deactivated") throw new Error("esperado desativação");
    expect(r.unchanged).toBe(false);
    expect(r.links.total).toBe(1);
    expect((await env.repos.categories.getById(env.company.id, "c1"))?.active).toBe(false);
    expect((await env.repos.receivables.getById(env.company.id, "r1"))?.categoryId).toBe("c1");

    const again = await removeReceivableCategory(env, env.company.id, "c1");
    expect(again.mode === "deactivated" && again.unchanged).toBe(true);

    const back = await reactivateReceivableCategory(env, env.company.id, "c1");
    expect(back.unchanged).toBe(false);
    expect(back.after.active).toBe(true);
    expect((await reactivateReceivableCategory(env, env.company.id, "c1")).unchanged).toBe(true);
  });

  it("categoria de despesa não pode ser excluída por esta tela", async () => {
    const env = createTestEnv();
    seedCategory(env, { id: "c_out", name: "Aluguel", kind: "expense", dreGroup: "despesas_operacionais" });
    await expect(removeReceivableCategory(env, env.company.id, "c_out")).rejects.toBeInstanceOf(NotFoundError);
  });
});
