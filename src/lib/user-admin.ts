/**
 * Administração de usuários e vínculos (RBAC) — regras determinísticas,
 * auditadas e testáveis com os repositórios em memória.
 *
 * Guardas de governança:
 * - exige permissão user.manage (papel admin);
 * - nunca deixa a empresa sem administrador ativo;
 * - ninguém altera o próprio papel nem desativa a si mesmo;
 * - "convite" no MVP é MOCK: gera senha temporária exibida uma única vez
 *   (nenhum e-mail é enviado).
 */

import { randomBytes } from "node:crypto";
import { assertPermission } from "@/core/auth";
import type { AuditTrail } from "@/core/audit";
import type { Clock } from "@/core/clock";
import type { Actor, ID, Membership, RoleName, User } from "@/core/entities";
import { NotFoundError, ValidationError } from "@/core/errors";
import type { IdGenerator } from "@/core/ids";
import type { Repositories } from "@/core/repositories";
import { hashPassword } from "@/lib/password";

export const ASSIGNABLE_ROLES: RoleName[] = [
  "admin",
  "finance_manager",
  "approver",
  "finance_analyst",
  "accountant",
  "viewer",
];

export interface UserAdminDeps {
  repos: Repositories;
  clock: Clock;
  ids: IdGenerator;
  audit: AuditTrail;
}

function assertRole(role: string): asserts role is RoleName {
  if (!ASSIGNABLE_ROLES.includes(role as RoleName)) {
    throw new ValidationError(`Papel inválido: ${role}.`);
  }
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ValidationError(`E-mail inválido: "${email}".`);
  }
  return value;
}

/** Administradores ATIVOS da empresa, opcionalmente ignorando um usuário. */
async function countActiveAdmins(
  repos: Repositories,
  companyId: ID,
  excludingUserId?: ID
): Promise<number> {
  const memberships = await repos.memberships.listByCompany(companyId);
  let count = 0;
  for (const m of memberships) {
    if (m.role !== "admin" || m.userId === excludingUserId) continue;
    const user = await repos.users.getById(m.userId);
    if (user?.active) count += 1;
  }
  return count;
}

export interface InviteUserInput {
  companyId: ID;
  actor: Actor;
  name: string;
  email: string;
  role: string;
  approvalLimitCents: number | null;
}

export interface InviteUserResult {
  user: User;
  membership: Membership;
  /** Presente apenas quando um usuário NOVO foi criado (convite mock). */
  temporaryPassword?: string;
  existingUser: boolean;
}

/**
 * Convida um usuário para a empresa: cria o usuário (com senha temporária,
 * convite MOCK) ou, se o e-mail já existe, apenas vincula à empresa.
 */
export async function inviteUser(
  deps: UserAdminDeps,
  input: InviteUserInput
): Promise<InviteUserResult> {
  const { repos, clock, ids, audit } = deps;
  assertPermission(input.actor, "user.manage");
  assertRole(input.role);
  const email = normalizeEmail(input.email);
  if (input.approvalLimitCents !== null && input.approvalLimitCents < 0) {
    throw new ValidationError("Limite de alçada não pode ser negativo.");
  }

  const now = clock.now().toISOString();
  let user = await repos.users.findByEmail(email);
  let temporaryPassword: string | undefined;
  const existingUser = user !== null;

  if (user) {
    const membership = await repos.memberships.findByUserAndCompany(user.id, input.companyId);
    if (membership) {
      throw new ValidationError(`${user.name} já tem acesso a esta empresa.`);
    }
  } else {
    if (!input.name.trim()) throw new ValidationError("Informe o nome do usuário.");
    // Exibida uma única vez; o sufixo fixo garante as classes exigidas pela
    // política de senha padrão (maiúscula/minúscula/dígito) — a entropia vem
    // dos 9 bytes aleatórios (12 chars base64url).
    temporaryPassword = `${randomBytes(9).toString("base64url")}Aa1`;
    user = await repos.users.create({
      id: ids.next("usr"),
      name: input.name.trim(),
      email,
      passwordHash: hashPassword(temporaryPassword),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await audit.record(input.companyId, {
      actor: input.actor,
      action: "user.created",
      entityType: "User",
      entityId: user.id,
      after: { name: user.name, email: user.email }, // nunca auditar hash de senha
    });
  }

  const membership = await repos.memberships.create({
    id: ids.next("mem"),
    userId: user.id,
    companyId: input.companyId,
    role: input.role,
    approvalLimitCents: input.approvalLimitCents,
  });
  await audit.record(input.companyId, {
    actor: input.actor,
    action: "membership.created",
    entityType: "Membership",
    entityId: membership.id,
    after: { userId: user.id, role: input.role, approvalLimitCents: input.approvalLimitCents },
  });

  return { user, membership, temporaryPassword, existingUser };
}

export interface UpdateMembershipInput {
  companyId: ID;
  actor: Actor;
  userId: ID;
  role: string;
  approvalLimitCents: number | null;
}

/** Altera papel e/ou limite de alçada do vínculo do usuário na empresa. */
export async function updateMembership(
  deps: UserAdminDeps,
  input: UpdateMembershipInput
): Promise<Membership> {
  const { repos, audit } = deps;
  assertPermission(input.actor, "user.manage");
  assertRole(input.role);
  if (input.actor.id === input.userId) {
    throw new ValidationError(
      "Você não pode alterar o próprio papel/alçada — peça a outro administrador."
    );
  }
  if (input.approvalLimitCents !== null && input.approvalLimitCents < 0) {
    throw new ValidationError("Limite de alçada não pode ser negativo.");
  }

  const membership = await repos.memberships.findByUserAndCompany(input.userId, input.companyId);
  if (!membership) throw new NotFoundError("Vínculo", input.userId);

  if (membership.role === "admin" && input.role !== "admin") {
    const remaining = await countActiveAdmins(repos, input.companyId, input.userId);
    if (remaining === 0) {
      throw new ValidationError(
        "A empresa ficaria sem administrador ativo — promova outro usuário antes."
      );
    }
  }

  const before = { role: membership.role, approvalLimitCents: membership.approvalLimitCents };
  const updated = await repos.memberships.update({
    ...membership,
    role: input.role,
    approvalLimitCents: input.approvalLimitCents,
  });
  await audit.record(input.companyId, {
    actor: input.actor,
    action: "membership.updated",
    entityType: "Membership",
    entityId: membership.id,
    before,
    after: { role: input.role, approvalLimitCents: input.approvalLimitCents },
  });
  return updated;
}

export interface SetUserActiveInput {
  companyId: ID;
  actor: Actor;
  userId: ID;
  active: boolean;
}

/**
 * Ativa/desativa o usuário. ATENÇÃO: o cadastro de usuário é global — desativar
 * bloqueia o login em TODAS as empresas em que ele atua (documentado na UI).
 */
export async function setUserActive(deps: UserAdminDeps, input: SetUserActiveInput): Promise<User> {
  const { repos, clock, audit } = deps;
  assertPermission(input.actor, "user.manage");
  if (input.actor.id === input.userId && !input.active) {
    throw new ValidationError("Você não pode desativar a si mesmo(a).");
  }

  const user = await repos.users.getById(input.userId);
  if (!user) throw new NotFoundError("Usuário", input.userId);
  const membership = await repos.memberships.findByUserAndCompany(input.userId, input.companyId);
  if (!membership) throw new NotFoundError("Vínculo", input.userId);
  if (user.active === input.active) return user;

  if (!input.active && membership.role === "admin") {
    const remaining = await countActiveAdmins(repos, input.companyId, input.userId);
    if (remaining === 0) {
      throw new ValidationError(
        "A empresa ficaria sem administrador ativo — promova outro usuário antes."
      );
    }
  }

  const updated = await repos.users.update({
    ...user,
    active: input.active,
    updatedAt: clock.now().toISOString(),
  });
  await audit.record(input.companyId, {
    actor: input.actor,
    action: input.active ? "user.reactivated" : "user.deactivated",
    entityType: "User",
    entityId: user.id,
    before: { active: user.active },
    after: { active: input.active },
  });
  return updated;
}
