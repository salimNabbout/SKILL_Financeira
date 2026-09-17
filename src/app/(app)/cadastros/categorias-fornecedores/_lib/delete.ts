/**
 * Exclusão de uma categoria (cadastro "Categoria A PAGAR"). Núcleo testável,
 * separado da server action.
 *
 * A categoria é referenciada pelo NOME (não por id, sem FK): `Supplier.category`,
 * `RecurringTemplate.category` e `Payable.supplierCategory`. Regra do app para
 * dado referenciado: nunca apagar fisicamente — "excluir" vira DESATIVAR
 * (active = false), como nos centros de custo; a categoria some das listas de
 * seleção e os registros existentes ficam intactos. Sem nenhum vínculo, a
 * exclusão é física (como o fornecedor sem títulos).
 */

import type { ID, SupplierCategory } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";

export interface CategoryDeleteDeps {
  repos: Repositories;
}

export interface SupplierCategoryLinks {
  suppliers: number;
  recurringTemplates: number;
  payables: number;
  total: number;
}

const same = (a: string | undefined, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** Quantos cadastros e títulos usam a categoria (comparação de nome sem caixa). */
export async function countSupplierCategoryLinks(
  deps: CategoryDeleteDeps,
  companyId: ID,
  name: string
): Promise<SupplierCategoryLinks> {
  const [suppliers, templates, payables] = await Promise.all([
    deps.repos.suppliers.listAll(companyId),
    deps.repos.recurringTemplates.listAll(companyId),
    deps.repos.payables.listAll(companyId),
  ]);
  const s = suppliers.filter((x) => same(x.category, name)).length;
  const r = templates.filter((x) => same(x.category, name)).length;
  const p = payables.filter((x) => same(x.supplierCategory, name)).length;
  return { suppliers: s, recurringTemplates: r, payables: p, total: s + r + p };
}

export type RemoveCategoryResult =
  | { mode: "deleted"; before: SupplierCategory; links: SupplierCategoryLinks }
  | {
      mode: "deactivated";
      before: SupplierCategory;
      after: SupplierCategory;
      links: SupplierCategoryLinks;
      /** true quando já estava inativa (nada foi escrito). */
      unchanged: boolean;
    };

/**
 * "Excluir": sem vínculos apaga a categoria; com vínculos desativa (idempotente).
 */
export async function removeSupplierCategory(
  deps: CategoryDeleteDeps,
  companyId: ID,
  id: ID,
  nowIso: string
): Promise<RemoveCategoryResult> {
  const before = await deps.repos.supplierCategories.getById(companyId, id);
  if (!before) throw new NotFoundError("Categoria", id);

  const links = await countSupplierCategoryLinks(deps, companyId, before.name);
  if (links.total === 0) {
    await deps.repos.supplierCategories.delete(companyId, id);
    return { mode: "deleted", before, links };
  }
  if (!before.active) {
    return { mode: "deactivated", before, after: before, links, unchanged: true };
  }
  const after = await deps.repos.supplierCategories.update({
    ...before,
    active: false,
    updatedAt: nowIso,
  });
  return { mode: "deactivated", before, after, links, unchanged: false };
}

/** Reativa uma categoria desativada (idempotente). */
export async function reactivateSupplierCategory(
  deps: CategoryDeleteDeps,
  companyId: ID,
  id: ID,
  nowIso: string
): Promise<{ before: SupplierCategory; after: SupplierCategory; unchanged: boolean }> {
  const before = await deps.repos.supplierCategories.getById(companyId, id);
  if (!before) throw new NotFoundError("Categoria", id);
  if (before.active) return { before, after: before, unchanged: true };
  const after = await deps.repos.supplierCategories.update({
    ...before,
    active: true,
    updatedAt: nowIso,
  });
  return { before, after, unchanged: false };
}
