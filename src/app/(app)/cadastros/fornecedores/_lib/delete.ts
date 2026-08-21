/**
 * Exclusão de fornecedor por nome. Núcleo testável, separado da server action.
 * Regra de integridade: um fornecedor com títulos a pagar vinculados NÃO pode
 * ser excluído (preservação do histórico financeiro; o banco também impede via
 * ON DELETE RESTRICT).
 */

import type { ID } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";
import { toUpperName } from "@/app/(app)/cadastros/_lib/form-utils";

export interface DeleteDeps {
  repos: Repositories;
}

/** Exclui o fornecedor cujo nome casa (ignorando caixa). Devolve o nome excluído. */
export async function deleteSupplierByName(
  deps: DeleteDeps,
  companyId: ID,
  rawName: string
): Promise<string> {
  const target = toUpperName(rawName);
  if (!target) throw new ValidationError("Selecione o fornecedor a excluir.");

  const suppliers = await deps.repos.suppliers.listAll(companyId);
  const supplier = suppliers.find((s) => s.name.trim().toUpperCase() === target);
  if (!supplier) throw new NotFoundError("Fornecedor", rawName);

  const payables = await deps.repos.payables.listAll(companyId);
  const linked = payables.filter((p) => p.supplierId === supplier.id).length;
  if (linked > 0) {
    throw new ValidationError(
      `Fornecedor "${supplier.name}" tem ${linked} título(s) a pagar vinculado(s) e não pode ser excluído. ` +
        `Cancele/liquide os títulos antes, ou mantenha o cadastro para preservar o histórico.`
    );
  }

  await deps.repos.suppliers.delete(companyId, supplier.id);
  return supplier.name;
}
