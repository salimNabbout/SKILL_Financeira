/**
 * Atualização dos dados de um fornecedor. Núcleo testável, separado da action.
 * Normaliza nome (MAIÚSCULAS) e categoria (Title Case), como na criação.
 */

import type { Clock } from "@/core/clock";
import type { CostClassification, ID, Supplier } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";
import { toTitleCase, toUpperName } from "@/app/(app)/cadastros/_lib/form-utils";

export interface UpdateDeps {
  repos: Repositories;
  clock: Clock;
}

export interface SupplierFields {
  name: string;
  document?: string;
  email?: string;
  phone?: string;
  costClassification?: CostClassification;
  category?: string;
}

/** Atualiza os campos editáveis do fornecedor e devolve o registro salvo. */
export async function updateSupplierFields(
  deps: UpdateDeps,
  companyId: ID,
  id: ID,
  fields: SupplierFields
): Promise<Supplier> {
  const current = await deps.repos.suppliers.getById(companyId, id);
  if (!current) throw new NotFoundError("Fornecedor", id);

  const updated: Supplier = {
    ...current,
    name: toUpperName(fields.name),
    document: fields.document,
    email: fields.email,
    phone: fields.phone,
    costClassification: fields.costClassification,
    category: fields.category ? toTitleCase(fields.category) : undefined,
    updatedAt: deps.clock.now().toISOString(),
  };
  return deps.repos.suppliers.update(updated);
}
