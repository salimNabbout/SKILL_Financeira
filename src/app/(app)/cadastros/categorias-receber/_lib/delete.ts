/**
 * Exclusão de uma categoria de receita ("Categoria a RECEBER"). Núcleo
 * testável, separado da server action.
 *
 * A categoria é referenciada por ID em títulos a receber, títulos a pagar e
 * linhas de orçamento (`categoryId`, com FK no banco). Regra do app para dado
 * referenciado: nunca apagar fisicamente — "excluir" vira DESATIVAR
 * (active = false): a categoria some do campo "Categoria (opcional)" de Contas
 * a receber e os registros existentes ficam intactos. Sem nenhum vínculo, a
 * exclusão é física.
 */

import type { Category, ID } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";

export interface CategoryDeleteDeps {
  repos: Repositories;
}

export interface ReceivableCategoryLinks {
  receivables: number;
  payables: number;
  budgetLines: number;
  total: number;
}

/** Quantos títulos e linhas de orçamento referenciam a categoria (por id). */
export async function countReceivableCategoryLinks(
  deps: CategoryDeleteDeps,
  companyId: ID,
  id: ID
): Promise<ReceivableCategoryLinks> {
  const [receivables, payables, budgets] = await Promise.all([
    deps.repos.receivables.listAll(companyId),
    deps.repos.payables.listAll(companyId),
    deps.repos.budgets.listAll(companyId),
  ]);
  const r = receivables.filter((x) => x.categoryId === id).length;
  const p = payables.filter((x) => x.categoryId === id).length;
  let b = 0;
  for (const budget of budgets) {
    const lines = await deps.repos.budgetLines.listByBudget(budget.id);
    b += lines.filter((l) => l.categoryId === id).length;
  }
  return { receivables: r, payables: p, budgetLines: b, total: r + p + b };
}

export type RemoveReceivableCategoryResult =
  | { mode: "deleted"; before: Category; links: ReceivableCategoryLinks }
  | {
      mode: "deactivated";
      before: Category;
      after: Category;
      links: ReceivableCategoryLinks;
      /** true quando já estava inativa (nada foi escrito). */
      unchanged: boolean;
    };

async function getIncome(deps: CategoryDeleteDeps, companyId: ID, id: ID): Promise<Category> {
  const category = await deps.repos.categories.getById(companyId, id);
  if (!category || category.kind !== "income") throw new NotFoundError("Categoria a receber", id);
  return category;
}

/** "Excluir": sem vínculos apaga a categoria; com vínculos desativa (idempotente). */
export async function removeReceivableCategory(
  deps: CategoryDeleteDeps,
  companyId: ID,
  id: ID
): Promise<RemoveReceivableCategoryResult> {
  const before = await getIncome(deps, companyId, id);
  const links = await countReceivableCategoryLinks(deps, companyId, id);
  if (links.total === 0) {
    await deps.repos.categories.delete(companyId, id);
    return { mode: "deleted", before, links };
  }
  if (!before.active) return { mode: "deactivated", before, after: before, links, unchanged: true };
  const after = await deps.repos.categories.update({ ...before, active: false });
  return { mode: "deactivated", before, after, links, unchanged: false };
}

/** Reativa uma categoria desativada (idempotente). */
export async function reactivateReceivableCategory(
  deps: CategoryDeleteDeps,
  companyId: ID,
  id: ID
): Promise<{ before: Category; after: Category; unchanged: boolean }> {
  const before = await getIncome(deps, companyId, id);
  if (before.active) return { before, after: before, unchanged: true };
  const after = await deps.repos.categories.update({ ...before, active: true });
  return { before, after, unchanged: false };
}
