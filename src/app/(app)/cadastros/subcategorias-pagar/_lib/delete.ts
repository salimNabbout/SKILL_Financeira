/**
 * Exclusão de uma Subcategoria a PAGAR. Núcleo testável, separado da server
 * action.
 *
 * A subcategoria é referenciada pelo NOME (sem FK) em `Payable.subcategory`.
 * Regra do app para dado referenciado: nunca apagar fisicamente — "excluir"
 * vira DESATIVAR (active = false), como nas categorias e nos centros de custo;
 * ela some da caixa de seleção e os títulos existentes ficam intactos. Sem
 * nenhum título usando o nome, a exclusão é física.
 */

import type { ID, PayableSubcategory } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";

export interface SubcategoryDeleteDeps {
  repos: Repositories;
}

export interface PayableSubcategoryLinks {
  payables: number;
  total: number;
}

const same = (a: string | undefined, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** Quantos títulos a pagar usam a subcategoria (comparação de nome sem caixa). */
export async function countPayableSubcategoryLinks(
  deps: SubcategoryDeleteDeps,
  companyId: ID,
  name: string
): Promise<PayableSubcategoryLinks> {
  const payables = await deps.repos.payables.listAll(companyId);
  const p = payables.filter((x) => same(x.subcategory, name)).length;
  return { payables: p, total: p };
}

export type RemoveSubcategoryResult =
  | { mode: "deleted"; before: PayableSubcategory; links: PayableSubcategoryLinks }
  | {
      mode: "deactivated";
      before: PayableSubcategory;
      after: PayableSubcategory;
      links: PayableSubcategoryLinks;
      /** true quando já estava inativa (nada foi escrito). */
      unchanged: boolean;
    };

/** "Excluir": sem títulos apaga a subcategoria; com títulos desativa (idempotente). */
export async function removePayableSubcategory(
  deps: SubcategoryDeleteDeps,
  companyId: ID,
  id: ID,
  nowIso: string
): Promise<RemoveSubcategoryResult> {
  const before = await deps.repos.payableSubcategories.getById(companyId, id);
  if (!before) throw new NotFoundError("Subcategoria", id);

  const links = await countPayableSubcategoryLinks(deps, companyId, before.name);
  if (links.total === 0) {
    await deps.repos.payableSubcategories.delete(companyId, id);
    return { mode: "deleted", before, links };
  }
  if (!before.active) return { mode: "deactivated", before, after: before, links, unchanged: true };
  const after = await deps.repos.payableSubcategories.update({ ...before, active: false, updatedAt: nowIso });
  return { mode: "deactivated", before, after, links, unchanged: false };
}

/** Reativa uma subcategoria desativada (idempotente). */
export async function reactivatePayableSubcategory(
  deps: SubcategoryDeleteDeps,
  companyId: ID,
  id: ID,
  nowIso: string
): Promise<{ before: PayableSubcategory; after: PayableSubcategory; unchanged: boolean }> {
  const before = await deps.repos.payableSubcategories.getById(companyId, id);
  if (!before) throw new NotFoundError("Subcategoria", id);
  if (before.active) return { before, after: before, unchanged: true };
  const after = await deps.repos.payableSubcategories.update({ ...before, active: true, updatedAt: nowIso });
  return { before, after, unchanged: false };
}
