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

/**
 * EXCEÇÃO NOMINAL à segregação de funções: e-mails autorizados a aprovar a
 * própria solicitação. Decisão de negócio do responsável pelo app — a lista é
 * nominal de propósito, para que a dispensa seja de pessoas identificadas e não
 * de um papel (dar isso ao papel "admin" liberaria qualquer admin futuro sem
 * ninguém decidir por isso).
 *
 * Comparação sempre em minúsculas: o e-mail do cadastro é normalizado assim.
 *
 * ⚠️ Continua sendo o controle de quatro olhos sendo dispensado: quem estiver
 * nesta lista pode solicitar e aprovar o próprio pagamento sozinho. A trilha de
 * auditoria registra solicitante e aprovador, então o caso fica visível — mas o
 * bloqueio não existe mais para essas pessoas. Para revogar, remova o e-mail.
 */
export const SELF_APPROVAL_EXEMPT_EMAILS: readonly string[] = ["salim@cetemrj.com.br"];

/** Este e-mail pode aprovar a própria solicitação? */
export function canSelfApprove(email?: string | null): boolean {
  if (!email) return false;
  return SELF_APPROVAL_EXEMPT_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * EXCEÇÃO NOMINAL para REDEFINIR a senha de outra pessoa. Lista própria, e
 * deliberadamente separada de SELF_APPROVAL_EXEMPT_EMAILS: autoaprovar
 * pagamento e trocar a senha de terceiros são poderes distintos, e ninguém
 * deve ganhar um por estar na lista do outro.
 *
 * O papel `admin` é condição necessária (permissão `user.manage`), não
 * suficiente: só quem está nesta lista redefine senha de outra pessoa.
 *
 * ⚠️ Quem está aqui pode assumir o acesso de qualquer usuário da empresa
 * (redefine a senha e entra com ela). A trilha registra a ação, com quem fez e
 * em quem — mas o poder é real. Para revogar, remova o e-mail.
 */
export const PASSWORD_RESET_EXEMPT_EMAILS: readonly string[] = ["salim@cetemrj.com.br"];

/** Este e-mail pode redefinir a senha de OUTRO usuário? */
export function canResetOthersPassword(email?: string | null): boolean {
  if (!email) return false;
  return PASSWORD_RESET_EXEMPT_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * Segregação de funções: quem solicita não pode aprovar a própria solicitação.
 *
 * `approverEmail` é opcional e serve só para a exceção nominal acima. Omitido,
 * a regra vale integralmente — nenhum chamador perde a proteção por esquecer o
 * parâmetro.
 */
export function assertSegregation(
  requestedBy: string,
  approverId: string,
  approverEmail?: string | null
): void {
  if (requestedBy !== approverId) return;
  if (canSelfApprove(approverEmail)) return;
  throw new SegregationError(
    "Segregação de funções: o solicitante não pode aprovar a própria solicitação."
  );
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
