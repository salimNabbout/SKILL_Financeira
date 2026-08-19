import { beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { verifyPassword } from "@/lib/password";
import { DEFAULT_PASSWORD_POLICY, validatePassword } from "@/core/password-policy";
import { inviteUser, setUserActive, updateMembership, type UserAdminDeps } from "../user-admin";

let env: TestEnv;
let deps: UserAdminDeps;

beforeEach(() => {
  env = createTestEnv();
  deps = { repos: env.repos, clock: env.clock, ids: env.ids, audit: env.audit };
});

describe("inviteUser", () => {
  it("cria usuário novo com senha temporária utilizável (convite mock)", async () => {
    const result = await inviteUser(deps, {
      companyId: env.company.id,
      actor: env.actorFor("admin"),
      name: "Fernanda Costa",
      email: "Fernanda@Teste.com.br",
      role: "finance_analyst",
      approvalLimitCents: 0,
    });

    expect(result.existingUser).toBe(false);
    expect(result.user.email).toBe("fernanda@teste.com.br"); // normalizado
    expect(result.temporaryPassword).toBeTruthy();
    expect(verifyPassword(result.temporaryPassword!, result.user.passwordHash)).toBe(true);
    // A senha temporária gerada sempre atende à política padrão.
    expect(validatePassword(DEFAULT_PASSWORD_POLICY, result.temporaryPassword!)).toEqual([]);
    expect(result.membership.role).toBe("finance_analyst");

    const audit = await env.repos.audit.list(env.company.id);
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("user.created");
    expect(actions).toContain("membership.created");
    // Hash de senha nunca vai para a auditoria.
    expect(JSON.stringify(audit)).not.toContain(result.user.passwordHash);
  });

  it("vincula usuário já existente (outra empresa) sem criar nem trocar senha", async () => {
    const first = await inviteUser(deps, {
      companyId: env.company.id,
      actor: env.actorFor("admin"),
      name: "Gustavo Reis",
      email: "gustavo@teste.com.br",
      role: "viewer",
      approvalLimitCents: null,
    });

    // Segunda empresa convida o mesmo e-mail.
    const now = env.clock.now().toISOString();
    await env.repos.companies.create({
      id: "co_2",
      name: "Empresa Dois",
      cnpj: "99.888.777/0001-66",
      timezone: "America/Sao_Paulo",
      defaultCurrency: "BRL",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    const second = await inviteUser(deps, {
      companyId: "co_2",
      actor: env.actorFor("admin"),
      name: "ignorado",
      email: "GUSTAVO@teste.com.br",
      role: "approver",
      approvalLimitCents: 100_000,
    });

    expect(second.existingUser).toBe(true);
    expect(second.temporaryPassword).toBeUndefined();
    expect(second.user.id).toBe(first.user.id);
    expect((await env.repos.memberships.listByUser(first.user.id)).length).toBe(2);
  });

  it("rejeita: vínculo duplicado, e-mail inválido, papel inválido e ator sem permissão", async () => {
    await expect(
      inviteUser(deps, {
        companyId: env.company.id,
        actor: env.actorFor("admin"),
        name: "X",
        email: "manager@teste.com.br", // já membro (test-env)
        role: "viewer",
        approvalLimitCents: null,
      })
    ).rejects.toThrow(/já tem acesso/);

    await expect(
      inviteUser(deps, {
        companyId: env.company.id,
        actor: env.actorFor("admin"),
        name: "X",
        email: "sem-arroba",
        role: "viewer",
        approvalLimitCents: null,
      })
    ).rejects.toThrow(/E-mail inválido/);

    await expect(
      inviteUser(deps, {
        companyId: env.company.id,
        actor: env.actorFor("admin"),
        name: "X",
        email: "x@y.com.br",
        role: "super_root",
        approvalLimitCents: null,
      })
    ).rejects.toThrow(/Papel inválido/);

    await expect(
      inviteUser(deps, {
        companyId: env.company.id,
        actor: env.actorFor("manager"), // finance_manager não tem user.manage
        name: "X",
        email: "x@y.com.br",
        role: "viewer",
        approvalLimitCents: null,
      })
    ).rejects.toThrow(/permissão/);
  });
});

describe("updateMembership", () => {
  it("altera papel e limite de alçada com auditoria before/after", async () => {
    const updated = await updateMembership(deps, {
      companyId: env.company.id,
      actor: env.actorFor("admin"),
      userId: env.users.analyst.id,
      role: "approver",
      approvalLimitCents: 250_000,
    });
    expect(updated.role).toBe("approver");
    expect(updated.approvalLimitCents).toBe(250_000);

    const audit = await env.repos.audit.list(env.company.id);
    const entry = audit.find((a) => a.action === "membership.updated");
    expect(entry?.before).toMatchObject({ role: "finance_analyst" });
    expect(entry?.after).toMatchObject({ role: "approver", approvalLimitCents: 250_000 });
  });

  it("bloqueia alterar o próprio papel e rebaixar o último admin ativo", async () => {
    await expect(
      updateMembership(deps, {
        companyId: env.company.id,
        actor: env.actorFor("admin"),
        userId: env.users.admin.id,
        role: "viewer",
        approvalLimitCents: null,
      })
    ).rejects.toThrow(/próprio papel/);

    // O test-env tem um único admin; outro admin fictício tenta rebaixá-lo.
    const otherAdmin = { type: "user" as const, id: "usr_admin2", role: "admin" as const };
    await expect(
      updateMembership(deps, {
        companyId: env.company.id,
        actor: otherAdmin,
        userId: env.users.admin.id,
        role: "finance_manager",
        approvalLimitCents: null,
      })
    ).rejects.toThrow(/sem administrador ativo/);
  });
});

describe("setUserActive", () => {
  it("desativa e reativa usuário com auditoria; idempotente quando o estado já é o desejado", async () => {
    const deactivated = await setUserActive(deps, {
      companyId: env.company.id,
      actor: env.actorFor("admin"),
      userId: env.users.viewer.id,
      active: false,
    });
    expect(deactivated.active).toBe(false);

    const again = await setUserActive(deps, {
      companyId: env.company.id,
      actor: env.actorFor("admin"),
      userId: env.users.viewer.id,
      active: false,
    });
    expect(again.active).toBe(false); // sem erro, sem nova auditoria

    const reactivated = await setUserActive(deps, {
      companyId: env.company.id,
      actor: env.actorFor("admin"),
      userId: env.users.viewer.id,
      active: true,
    });
    expect(reactivated.active).toBe(true);

    const actions = (await env.repos.audit.list(env.company.id)).map((a) => a.action);
    expect(actions.filter((a) => a === "user.deactivated")).toHaveLength(1);
    expect(actions.filter((a) => a === "user.reactivated")).toHaveLength(1);
  });

  it("bloqueia autodesativação e desativar o último admin ativo", async () => {
    await expect(
      setUserActive(deps, {
        companyId: env.company.id,
        actor: env.actorFor("admin"),
        userId: env.users.admin.id,
        active: false,
      })
    ).rejects.toThrow(/a si mesmo/);

    const otherAdmin = { type: "user" as const, id: "usr_admin2", role: "admin" as const };
    await expect(
      setUserActive(deps, {
        companyId: env.company.id,
        actor: otherAdmin,
        userId: env.users.admin.id,
        active: false,
      })
    ).rejects.toThrow(/sem administrador ativo/);
  });
});
