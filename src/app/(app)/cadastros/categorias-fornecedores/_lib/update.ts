/**
 * Renomeação de uma Categoria de Fornecedores, EM CASCATA. Núcleo testável,
 * separado da server action (que só cuida de sessão/permissão/redirect).
 *
 * Por que cascata: fornecedores e recorrências referenciam a categoria pelo
 * NOME, não por id — ver `Supplier.category` e `RecurringTemplate.category` em
 * src/core/entities.ts. Renomear só a linha da categoria deixaria esses
 * registros apontando para um nome que não existe mais na lista, sem erro
 * nenhum e sem ninguém perceber.
 *
 * Por isso a propagação acontece dentro de `withTransaction`: ou todos os
 * registros passam a apontar para o nome novo, ou nada muda. Uma falha no meio
 * deixaria parte da base órfã, que é exatamente o que se quer evitar.
 */

import type { Clock } from "@/core/clock";
import type { ID, SupplierCategory } from "@/core/entities";
import { ValidationError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";
import { toTitleCase } from "@/app/(app)/cadastros/_lib/form-utils";

export interface RenameCategoryDeps {
  repos: Repositories;
  clock: Clock;
}

export interface RenameCategoryResult {
  before: SupplierCategory;
  after: SupplierCategory;
  /** Quantos fornecedores tiveram o campo `category` atualizado. */
  suppliersAtualizados: number;
  /** Quantas recorrências tiveram o campo `category` atualizado. */
  recorrenciasAtualizadas: number;
  /** true quando o nome enviado é igual ao atual (nada foi escrito). */
  semMudanca: boolean;
}

/**
 * Renomeia a categoria e propaga o novo nome para fornecedores e recorrências
 * que a usavam. Idempotente: renomear para o mesmo nome não escreve nada.
 */
export async function renameSupplierCategory(
  deps: RenameCategoryDeps,
  companyId: ID,
  id: ID,
  rawName: string
): Promise<RenameCategoryResult> {
  const name = toTitleCase(rawName);
  if (!name) throw new ValidationError("Informe o nome da categoria.");

  const before = await deps.repos.supplierCategories.getById(companyId, id);
  if (!before) throw new ValidationError("Categoria não encontrada.");

  if (before.name === name) {
    return {
      before,
      after: before,
      suppliersAtualizados: 0,
      recorrenciasAtualizadas: 0,
      semMudanca: true,
    };
  }

  // Mesma normalização do caminho de criação (addSupplierCategory): "Serviços"
  // e "serviços" são a mesma categoria nos dois fluxos.
  const todas = await deps.repos.supplierCategories.listAll(companyId);
  const duplicada = todas.find(
    (c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicada) {
    throw new ValidationError(`Já existe uma categoria chamada "${duplicada.name}".`);
  }

  const nomeAntigo = before.name.toLowerCase();
  const agora = deps.clock.now().toISOString();

  return deps.repos.withTransaction(async (tx) => {
    const after = await tx.supplierCategories.update({ ...before, name, updatedAt: agora });

    let suppliersAtualizados = 0;
    for (const fornecedor of await tx.suppliers.listAll(companyId)) {
      if (fornecedor.category && fornecedor.category.toLowerCase() === nomeAntigo) {
        await tx.suppliers.update({ ...fornecedor, category: name, updatedAt: agora });
        suppliersAtualizados += 1;
      }
    }

    let recorrenciasAtualizadas = 0;
    for (const recorrencia of await tx.recurringTemplates.listAll(companyId)) {
      if (recorrencia.category && recorrencia.category.toLowerCase() === nomeAntigo) {
        await tx.recurringTemplates.update({ ...recorrencia, category: name, updatedAt: agora });
        recorrenciasAtualizadas += 1;
      }
    }

    return { before, after, suppliersAtualizados, recorrenciasAtualizadas, semMudanca: false };
  });
}
