/**
 * Núcleo testável do cadastro de centros de custo (edição, ativação/desativação
 * e contagem de vínculos), separado da server action. O app não faz exclusão
 * física de dado referenciado: "excluir" é DESATIVAR (active = false).
 */

import type { CostCenter, ID } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import type { Repositories } from "@/core/repositories";

export interface CostCenterDeps {
  repos: Repositories;
}

export interface CostCenterFields {
  code: string;
  name: string;
}

/** Compara códigos de forma case-insensitive — mesma regra da criação. */
function sameCode(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Atualiza código e nome de um centro de custo. Rejeita código vazio, nome
 * vazio e código já usado por OUTRO centro de custo (case-insensitive).
 * Devolve { before, after } para a trilha de auditoria.
 */
export async function updateCostCenterFields(
  deps: CostCenterDeps,
  companyId: ID,
  id: ID,
  fields: CostCenterFields
): Promise<{ before: CostCenter; after: CostCenter }> {
  const code = fields.code.trim();
  const name = fields.name.trim();
  if (!code || !name) {
    throw new ValidationError("Informe código e nome do centro de custo.");
  }

  const current = await deps.repos.costCenters.getById(companyId, id);
  if (!current) throw new NotFoundError("Centro de custo", id);

  const all = await deps.repos.costCenters.listAll(companyId);
  const clash = all.find((c) => c.id !== id && sameCode(c.code, code));
  if (clash) {
    throw new ValidationError(
      `Já existe um centro de custo com o código "${clash.code}".`
    );
  }

  const before = { ...current };
  const after = await deps.repos.costCenters.update({ ...current, code, name });
  return { before, after };
}

/**
 * Ativa/desativa um centro de custo (idempotente: se já estiver no estado
 * desejado, devolve unchanged=true e não grava). Devolve { before, after }.
 */
export async function setCostCenterActive(
  deps: CostCenterDeps,
  companyId: ID,
  id: ID,
  active: boolean
): Promise<{ before: CostCenter; after: CostCenter; unchanged: boolean }> {
  const current = await deps.repos.costCenters.getById(companyId, id);
  if (!current) throw new NotFoundError("Centro de custo", id);

  if (current.active === active) {
    return { before: current, after: current, unchanged: true };
  }
  const before = { ...current };
  const after = await deps.repos.costCenters.update({ ...current, active });
  return { before, after, unchanged: false };
}

/**
 * Conta quantos lançamentos referenciam um centro de custo: títulos a pagar,
 * a receber e linhas de orçamento (as três tabelas com costCenterId). Serve
 * para avisar o usuário antes de desativar. BudgetLine não tem listAll, então
 * é somada por orçamento (aceitável no MVP; volumetria pequena).
 */
export async function countCostCenterLinks(
  deps: CostCenterDeps,
  companyId: ID,
  id: ID
): Promise<number> {
  const [payables, receivables, budgets] = await Promise.all([
    deps.repos.payables.listAll(companyId),
    deps.repos.receivables.listAll(companyId),
    deps.repos.budgets.listAll(companyId),
  ]);

  let count = 0;
  count += payables.filter((p) => p.costCenterId === id).length;
  count += receivables.filter((r) => r.costCenterId === id).length;
  for (const b of budgets) {
    const lines = await deps.repos.budgetLines.listByBudget(b.id);
    count += lines.filter((l) => l.costCenterId === id).length;
  }
  return count;
}
