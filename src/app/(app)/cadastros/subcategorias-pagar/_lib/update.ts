/**
 * Renomeação de uma Subcategoria a PAGAR. Núcleo testável, separado da server
 * action.
 *
 * Sem cascata: a subcategoria é referenciada pelo NOME só em
 * `Payable.subcategory` (títulos já lançados), e o título guarda o que foi
 * escolhido no momento do lançamento — mesma regra de `Payable.supplierCategory`,
 * que também não é reescrito quando a categoria muda de nome.
 */

import type { Clock } from "@/core/clock";
import type { ID, PayableSubcategory } from "@/core/entities";
import { ValidationError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";
import { toTitleCase } from "@/app/(app)/cadastros/_lib/form-utils";

export interface RenameSubcategoryDeps {
  repos: Repositories;
  clock: Clock;
}

export interface RenameSubcategoryResult {
  before: PayableSubcategory;
  after: PayableSubcategory;
  /** true quando o nome enviado é igual ao atual (nada foi escrito). */
  semMudanca: boolean;
}

/** Renomeia a subcategoria. Idempotente: renomear para o mesmo nome não escreve nada. */
export async function renamePayableSubcategory(
  deps: RenameSubcategoryDeps,
  companyId: ID,
  id: ID,
  rawName: string
): Promise<RenameSubcategoryResult> {
  const name = toTitleCase(rawName);
  if (!name) throw new ValidationError("Informe o nome da subcategoria.");

  const before = await deps.repos.payableSubcategories.getById(companyId, id);
  if (!before) throw new ValidationError("Subcategoria não encontrada.");
  if (before.name === name) return { before, after: before, semMudanca: true };

  // Mesma normalização do caminho de criação: "Energia" e "energia" são a mesma.
  const todas = await deps.repos.payableSubcategories.listAll(companyId);
  const duplicada = todas.find((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase());
  if (duplicada) throw new ValidationError(`Já existe uma subcategoria chamada "${duplicada.name}".`);

  const after = await deps.repos.payableSubcategories.update({
    ...before,
    name,
    updatedAt: deps.clock.now().toISOString(),
  });
  return { before, after, semMudanca: false };
}
