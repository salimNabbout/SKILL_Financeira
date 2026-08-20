/**
 * Criação idempotente de uma Categoria de Fornecedores. Núcleo testável,
 * separado da server action (que só cuida de sessão/permissão/redirect).
 */

import type { Clock } from "@/core/clock";
import type { ID, SupplierCategory } from "@/core/entities";
import { ValidationError } from "@/core/errors";
import type { IdGenerator } from "@/core/ids";
import type { Repositories } from "@/core/repositories";
import { toTitleCase } from "@/app/(app)/cadastros/_lib/form-utils";

export interface CategoryDeps {
  repos: Repositories;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Cria a categoria (nome em Title Case) se ainda não existir na empresa.
 * Idempotente por nome (ignorando caixa). Devolve a categoria e se foi criada.
 */
export async function addSupplierCategory(
  deps: CategoryDeps,
  companyId: ID,
  rawName: string
): Promise<{ category: SupplierCategory; created: boolean }> {
  const name = toTitleCase(rawName);
  if (!name) throw new ValidationError("Informe o nome da categoria.");

  const existing = (await deps.repos.supplierCategories.listAll(companyId)).find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return { category: existing, created: false };

  const now = deps.clock.now().toISOString();
  const category = await deps.repos.supplierCategories.create({
    id: deps.ids.next("supcat"),
    companyId,
    name,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return { category, created: true };
}
