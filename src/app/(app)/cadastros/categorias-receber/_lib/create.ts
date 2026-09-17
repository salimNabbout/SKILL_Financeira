/**
 * Cadastro "Categoria a RECEBER": criação idempotente de uma categoria de
 * RECEITA (`Category` com kind = "income"). São exatamente as categorias que
 * alimentam o campo "Categoria (opcional)" de Contas a receber, que grava
 * `Receivable.categoryId`. Núcleo testável, separado da server action.
 */

import type { Category, ID } from "@/core/entities";
import { ValidationError } from "@/core/errors";
import type { IdGenerator } from "@/core/ids";
import type { Repositories } from "@/core/repositories";
import { toTitleCase } from "@/app/(app)/cadastros/_lib/form-utils";

export interface ReceivableCategoryDeps {
  repos: Repositories;
  ids: IdGenerator;
}

/** Só as categorias de receita — o que a tela lista e o select de Contas a receber usa. */
export async function listReceivableCategories(
  deps: Pick<ReceivableCategoryDeps, "repos">,
  companyId: ID
): Promise<Category[]> {
  return (await deps.repos.categories.listAll(companyId)).filter((c) => c.kind === "income");
}

/**
 * Cria a categoria de receita (nome em Title Case; grupo do DRE "receita
 * bruta") se ainda não existir. Idempotente por nome (ignorando caixa).
 */
export async function addReceivableCategory(
  deps: ReceivableCategoryDeps,
  companyId: ID,
  rawName: string
): Promise<{ category: Category; created: boolean }> {
  const name = toTitleCase(rawName);
  if (!name) throw new ValidationError("Informe o nome da categoria.");

  const existing = (await listReceivableCategories(deps, companyId)).find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return { category: existing, created: false };

  const category = await deps.repos.categories.create({
    id: deps.ids.next("cat"),
    companyId,
    name,
    kind: "income",
    dreGroup: "receita_bruta",
    active: true,
  });
  return { category, created: true };
}
