/**
 * Criação idempotente de uma Subcategoria a PAGAR (lista que alimenta a caixa
 * SUBCATEGORIA do novo título). Núcleo testável, separado da server action
 * (que só cuida de sessão/permissão/redirect). Mesmo desenho de
 * `categorias-fornecedores/_lib/create.ts`.
 */

import type { Clock } from "@/core/clock";
import type { ID, PayableSubcategory } from "@/core/entities";
import { ValidationError } from "@/core/errors";
import type { IdGenerator } from "@/core/ids";
import type { Repositories } from "@/core/repositories";
import { toTitleCase } from "@/app/(app)/cadastros/_lib/form-utils";

export interface SubcategoryDeps {
  repos: Repositories;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Cria a subcategoria (nome em Title Case) se ainda não existir na empresa.
 * Idempotente por nome (ignorando caixa). Devolve a subcategoria e se foi criada.
 */
export async function addPayableSubcategory(
  deps: SubcategoryDeps,
  companyId: ID,
  rawName: string
): Promise<{ subcategory: PayableSubcategory; created: boolean }> {
  const name = toTitleCase(rawName);
  if (!name) throw new ValidationError("Informe o nome da subcategoria.");

  const existing = (await deps.repos.payableSubcategories.listAll(companyId)).find(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return { subcategory: existing, created: false };

  const now = deps.clock.now().toISOString();
  const subcategory = await deps.repos.payableSubcategories.create({
    id: deps.ids.next("paysub"),
    companyId,
    name,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return { subcategory, created: true };
}
