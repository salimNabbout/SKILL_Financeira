/**
 * Renomeação de uma categoria de receita ("Categoria a RECEBER"). Os títulos
 * a receber apontam para a categoria por ID (`Receivable.categoryId`), então
 * renomear não exige cascata. Núcleo testável, separado da server action.
 */

import type { Category, ID } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";
import { toTitleCase } from "@/app/(app)/cadastros/_lib/form-utils";
import { listReceivableCategories } from "./create";

export interface RenameReceivableCategoryResult {
  before: Category;
  after: Category;
  /** true quando o nome enviado é igual ao atual (nada foi escrito). */
  semMudanca: boolean;
}

export async function renameReceivableCategory(
  deps: { repos: Repositories },
  companyId: ID,
  id: ID,
  rawName: string
): Promise<RenameReceivableCategoryResult> {
  const name = toTitleCase(rawName);
  if (!name) throw new ValidationError("Informe o nome da categoria.");

  const before = await deps.repos.categories.getById(companyId, id);
  if (!before || before.kind !== "income") throw new NotFoundError("Categoria a receber", id);
  if (before.name === name) return { before, after: before, semMudanca: true };

  const duplicada = (await listReceivableCategories(deps, companyId)).find(
    (c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicada) {
    throw new ValidationError(`Já existe uma categoria chamada "${duplicada.name}".`);
  }

  const after = await deps.repos.categories.update({ ...before, name });
  return { before, after, semMudanca: false };
}
