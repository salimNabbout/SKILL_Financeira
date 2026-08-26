/**
 * RBAC: papéis por empresa, permissões e segregação de funções.
 * Regras determinísticas — a IA nunca decide permissão.
 */

import type { Actor, Membership, RoleName } from "./entities";
import { PermissionError, SegregationError } from "./errors";

export type Permission =
  | "company.manage"
  | "user.manage"
  | "master_data.manage" // clientes, fornecedores, categorias, centros de custo, plano de contas
  | "bank_account.manage"
  | "payable.create"
  | "payable.cancel"
  | "receivable.create"
  | "receivable.settle"
  | "receivable.cancel"
  | "payment.request"
  | "payment.approve"
  | "payment.execute"
  | "invoice.manage"
  | "collection.manage"
  | "collection.approve"
  | "reconciliation.manage"
  | "budget.manage"
  | "accounting.export"
  | "report.view"
  | "audit.view"
  | "flow.execute";

/** Matriz papel -> permissões. viewer só lê; approver decide, não cria nem executa. */
const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  admin: [
    "company.manage",
    "user.manage",
    "master_data.manage",
    "bank_account.manage",
    "payable.create",
    "payable.cancel",
    "receivable.create",
    "receivable.settle",
    "receivable.cancel",
    "payment.request",
    "payment.approve",
    "payment.execute",
    "invoice.manage",
    "collection.manage",
    "collection.approve",
    "reconciliation.manage",
    "budget.manage",
    "accounting.export",
    "report.view",
    "audit.view",
    "flow.execute",
  ],
  finance_manager: [
    "master_data.manage",
    "bank_account.manage",
    "payable.create",
    "payable.cancel",
    "receivable.create",
    "receivable.settle",
    "receivable.cancel",
    "payment.request",
    "payment.approve",
    "payment.execute",
    "invoice.manage",
    "collection.manage",
    "collection.approve",
    "reconciliation.manage",
    "budget.manage",
    "accounting.export",
    "report.view",
    "audit.view",
    "flow.execute",
  ],
  approver: ["payment.approve", "collection.approve", "report.view", "flow.execute"],
  finance_analyst: [
    "master_data.manage",
    "payable.create",
    "receivable.create",
    "receivable.settle",
    "payment.request",
    "invoice.manage",
    "collection.manage",
    "reconciliation.manage",
    "budget.manage",
    "report.view",
    "flow.execute",
  ],
  accountant: ["accounting.export", "report.view", "audit.view", "flow.execute"],
  viewer: ["report.view"],
};

/** Hierarquia para "papel mínimo exigido" em aprovações. */
const ROLE_RANK: Record<RoleName, number> = {
  viewer: 0,
  accountant: 1,
  finance_analyst: 2,
  approver: 3,
  finance_manager: 4,
  admin: 5,
};

export function roleAtLeast(role: RoleName, required: RoleName): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function hasPermission(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertPermission(actor: Actor, permission: Permission): void {
  if (actor.type === "system" || actor.type === "skill") return; // ações internas auditadas à parte
  if (!actor.role || !hasPermission(actor.role, permission)) {
    throw new PermissionError(
      `Usuário ${actor.id} (papel ${actor.role ?? "nenhum"}) não possui a permissão ${permission}`
    );
  }
}

/** Segregação de funções: quem solicita não pode aprovar a própria solicitação. */
export function assertSegregation(requestedBy: string, approverId: string): void {
  if (requestedBy === approverId) {
    throw new SegregationError(
      "Segregação de funções: o solicitante não pode aprovar a própria solicitação."
    );
  }
}

/**
 * Verifica alçada: o aprovador precisa de papel mínimo e limite suficiente.
 * approvalLimitCents null = ilimitado dentro do papel.
 */
export function canApproveAmount(
  membership: Membership,
  requiredRole: RoleName,
  amountCents: number | undefined
): { allowed: boolean; reason?: string } {
  if (!roleAtLeast(membership.role, requiredRole)) {
    return {
      allowed: false,
      reason: `Papel ${membership.role} abaixo do mínimo exigido (${requiredRole}).`,
    };
  }
  if (
    amountCents !== undefined &&
    membership.approvalLimitCents !== null &&
    amountCents > membership.approvalLimitCents
  ) {
    return {
      allowed: false,
      reason: `Valor acima do limite de alçada do aprovador (${membership.approvalLimitCents} centavos).`,
    };
  }
  return { allowed: true };
}
