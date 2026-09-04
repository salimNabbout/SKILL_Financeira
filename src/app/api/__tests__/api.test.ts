/**
 * Testes da camada de API (lógica de handlers + envelopes de resposta).
 * As rotas do Next são camadas finas sobre estas funções; aqui exercitamos a
 * lógica com createTestEnv (determinístico) e um registro de skills falsas —
 * assim os testes não dependem das implementações reais das skills (em
 * desenvolvimento paralelo).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { NotFoundError, PermissionError, SegregationError, ValidationError } from "@/core/errors";
import type { Payable } from "@/core/entities";
import { SkillRegistry } from "@/core/orchestrator/registry";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import { makeResult, SKILL_NAMES, type SkillDefinition, type SkillName } from "@/core/skill";
import { hashPassword } from "@/lib/password";
import { InMemoryRateLimiter } from "@/lib/rate-limit";
import { generateTotpSecret, totpCode } from "@/lib/totp";
import { contabilSkill } from "@/skills/contabil";
import {
  acknowledgeAlert,
  createBankAccount,
  createSupplier,
  decideApproval,
  executeFlow,
  exportAccountingBatch,
  getAuditTrail,
  getMe,
  getPayable,
  importStatement,
  listAlerts,
  listBankAccounts,
  listBankTransactions,
  listCompanies,
  listCompanyUsers,
  listFlows,
  listPayables,
  listSkills,
  listSuppliers,
  login,
  type ApiDeps,
  type ApiSession,
} from "../_lib/handlers";
import { runReport } from "../_lib/reports";
import { buildRegistry } from "@/skills";
import {
  errorResponse,
  json,
  jsonError,
  maskSensitive,
  publicUser,
  statusForErrorCode,
} from "../_lib/respond";

// ---------------------------------------------------------------------------
// Infra de teste
// ---------------------------------------------------------------------------

const echoSchema = z.object({ action: z.string() }).passthrough();

function fakeSkill(
  name: SkillName,
  execute?: SkillDefinition["execute"]
): SkillDefinition {
  return {
    name,
    responsibility: `fake ${name}`,
    objective: `objetivo fake de ${name}`,
    inputSchema: echoSchema,
    consumes: [],
    publishes: [],
    dataSources: [`${name}_db`],
    execute:
      execute ??
      (async (ctx, input) =>
        makeResult(name, ctx, { echoed: (input as { action: string }).action })),
  };
}

/** contas_a_pagar fake: schedule_payment segue o protocolo de aprovação humana. */
function fakeContasAPagar(): SkillDefinition {
  return fakeSkill("contas_a_pagar", async (ctx, input) => {
    const { action } = input as { action: string };
    if (action !== "schedule_payment") {
      return makeResult("contas_a_pagar", ctx, { echoed: action });
    }
    if (ctx.approval?.status === "approved") {
      return makeResult("contas_a_pagar", ctx, {
        payment: { id: "pay_teste", status: "executed" },
        decidedBy: ctx.approval.decidedBy,
      });
    }
    if (ctx.approval?.status === "rejected") {
      return makeResult("contas_a_pagar", ctx, {
        payment: { id: "pay_teste", status: "canceled" },
      });
    }
    return makeResult(
      "contas_a_pagar",
      ctx,
      {
        payment: { id: "pay_teste", status: "pending_approval" },
        approvalRequest: {
          targetType: "payment",
          targetId: "pay_teste",
          summary: "Pagamento de R$ 250,00",
          amountCents: 25_000,
        },
      },
      { status: "awaiting_approval", requiresHumanApproval: true }
    );
  });
}

function fakeRelatorios(): SkillDefinition {
  return fakeSkill("relatorios_gerenciais", async (ctx, input) => {
    const raw = input as { action: string; report?: string; period?: string };
    if (raw.action === "export_data") {
      return makeResult("relatorios_gerenciais", ctx, {
        report: raw.report,
        title: "Relatório de Teste",
        subtitle: "Gerado em ambiente de teste",
        rows: [
          { metrica: "saldo_caixa", valor: "R$ 1.234,56", unidade: "BRL", fonte: "tesouraria" },
          { metrica: "titulos_vencidos", valor: 3, unidade: "quantidade", fonte: "contas_a_receber" },
        ],
      });
    }
    return makeResult("relatorios_gerenciais", ctx, {
      action: raw.action,
      period: raw.period ?? null,
      ok: true,
    });
  });
}

function buildFakeRegistry(): SkillRegistry {
  const custom = new Map<SkillName, SkillDefinition>([
    ["contas_a_pagar", fakeContasAPagar()],
    ["relatorios_gerenciais", fakeRelatorios()],
  ]);
  const registry = new SkillRegistry();
  for (const name of SKILL_NAMES) {
    registry.register(custom.get(name) ?? fakeSkill(name));
  }
  return registry;
}

function buildDeps(env: TestEnv, registry: SkillRegistry = buildFakeRegistry()): ApiDeps {
  return {
    repos: env.repos,
    events: env.events,
    audit: env.audit,
    clock: env.clock,
    ids: env.ids,
    ai: env.ai,
    integrations: env.integrations,
    registry,
    orchestrator: env.orchestrator(registry),
  };
}

type UserKey = "admin" | "manager" | "analyst" | "approver" | "viewer";

async function sessionFor(env: TestEnv, key: UserKey): Promise<ApiSession> {
  const user = env.users[key];
  const membership = await env.repos.memberships.findByUserAndCompany(user.id, env.company.id);
  if (!membership) throw new Error(`membership ausente para ${key}`);
  return {
    user,
    membership,
    company: env.company,
    config: env.config,
    actor: { type: "user", id: user.id, role: membership.role },
  };
}

function seedPayable(env: TestEnv, overrides: Partial<Payable>): Promise<Payable> {
  const now = env.clock.now().toISOString();
  return env.repos.payables.create({
    id: env.ids.next("pay"),
    companyId: env.company.id,
    supplierId: "sup_x",
    description: "Título de teste",
    issueDate: "2026-08-01",
    dueDate: "2026-08-20",
    amountCents: 100_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: env.ids.next("ok"),
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

// Exportadores são escritos por outro agente em paralelo; testes de CSV/PDF
// só rodam quando o módulo já existir.
const exportersAvailable = await import("@/lib/exporters").then(
  () => true,
  () => false
);

// ---------------------------------------------------------------------------
// Envelopes e sanitização
// ---------------------------------------------------------------------------

describe("respond: envelopes padronizados", () => {
  it("json embrulha em { data } com status configurável", async () => {
    const res = json({ ok: true }, 201);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  it("jsonError embrulha em { error: { code, message } }", async () => {
    const res = jsonError("not_found", "Nada aqui.", 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Nada aqui." } });
  });

  it("mapeia DomainError para o status HTTP correto", () => {
    expect(statusForErrorCode("validation_error")).toBe(400);
    expect(statusForErrorCode("invalid_input")).toBe(400);
    expect(statusForErrorCode("invalid_credentials")).toBe(401);
    expect(statusForErrorCode("permission_denied")).toBe(403);
    expect(statusForErrorCode("segregation_of_duties")).toBe(403);
    expect(statusForErrorCode("not_found")).toBe(404);
    expect(statusForErrorCode("qualquer_outro")).toBe(500);
  });

  it("errorResponse traduz erros de domínio e nunca vaza detalhes internos", async () => {
    expect(errorResponse(new ValidationError("campo x")).status).toBe(400);
    expect(errorResponse(new PermissionError("sem acesso")).status).toBe(403);
    expect(errorResponse(new NotFoundError("Coisa", "c1")).status).toBe(404);
    expect(errorResponse(new SegregationError("segregação")).status).toBe(403);

    const res = errorResponse(new Error("stack secreta em /caminho/interno.ts"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Erro interno do servidor.");
    expect(JSON.stringify(body)).not.toContain("caminho/interno");
  });

  it("maskSensitive preserva só os 4 últimos caracteres", () => {
    expect(maskSensitive("987654321")).toBe("*****4321");
    expect(maskSensitive("12-3")).toBe("****");
    expect(maskSensitive("ab")).toBe("****");
  });

  it("publicUser remove passwordHash e totpSecret (allowlist)", () => {
    const sanitized = publicUser({
      id: "u1",
      name: "Ana",
      email: "ana@x.com",
      passwordHash: "scrypt$...",
      totpSecret: "GEZDGNBVGY3TQOJQ",
      totpEnabled: true,
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(sanitized).toEqual({
      id: "u1",
      name: "Ana",
      email: "ana@x.com",
      active: true,
      totpEnabled: true,
    });
    expect(JSON.stringify(sanitized)).not.toContain("scrypt");
    expect(JSON.stringify(sanitized)).not.toContain("GEZDGNBV");
  });
});

// ---------------------------------------------------------------------------
// Autenticação e sessão
// ---------------------------------------------------------------------------

describe("auth/login", () => {
  async function seedLoginUser(env: TestEnv) {
    const now = env.clock.now().toISOString();
    const user = await env.repos.users.create({
      id: "usr_login",
      name: "Maria Login",
      email: "maria@teste.com.br",
      passwordHash: hashPassword("Segredo#123"),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await env.repos.memberships.create({
      id: "mem_login",
      userId: user.id,
      companyId: env.company.id,
      role: "viewer",
      approvalLimitCents: 0,
    });
    return user;
  }

  it("bloqueia após exceder o limite de tentativas por (chave, e-mail)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seedLoginUser(env);

    let now = 0;
    const rateLimiter = new InMemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000, now: () => now });
    const ctx = { clientKey: "1.2.3.4", rateLimiter };
    const bad = { email: "maria@teste.com.br", password: "errada" };

    // 3 tentativas falhas consumem a janela.
    for (let i = 0; i < 3; i++) {
      await expect(login(deps, bad, ctx)).rejects.toThrow(/inválidos/);
    }
    // A 4ª — mesmo com a senha CORRETA — é barrada pelo rate limit.
    await expect(
      login(deps, { email: "maria@teste.com.br", password: "Segredo#123" }, ctx)
    ).rejects.toThrow(/muitas tentativas/i);
  });

  it("login bem-sucedido zera o contador de tentativas da chave", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seedLoginUser(env);

    let now = 0;
    const rateLimiter = new InMemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000, now: () => now });
    const ctx = { clientKey: "1.2.3.4", rateLimiter };

    await expect(
      login(deps, { email: "maria@teste.com.br", password: "errada" }, ctx)
    ).rejects.toThrow(/inválidos/);
    // Sucesso reseta: novas tentativas voltam a ser permitidas sem bloqueio.
    await login(deps, { email: "maria@teste.com.br", password: "Segredo#123" }, ctx);
    for (let i = 0; i < 3; i++) {
      await expect(
        login(deps, { email: "maria@teste.com.br", password: "errada" }, ctx)
      ).rejects.toThrow(/inválidos/);
    }
  });

  it("credenciais válidas devolvem usuário (sem hash) e companyId, com auditoria", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seedLoginUser(env);

    const result = await login(deps, { email: "maria@teste.com.br", password: "Segredo#123" });
    expect(result.companyId).toBe(env.company.id);
    expect(result.user).toEqual({
      id: "usr_login",
      name: "Maria Login",
      email: "maria@teste.com.br",
      active: true,
      totpEnabled: false,
    });
    expect(JSON.stringify(result)).not.toContain("scrypt");

    const audit = await env.repos.audit.list(env.company.id);
    expect(audit.map((a) => a.action)).toContain("auth.login");
  });

  it("conta com 2FA ativo exige código TOTP válido (e nunca vaza o segredo)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const seeded = await seedLoginUser(env);
    const secret = generateTotpSecret();
    await env.repos.users.update({ ...seeded, totpSecret: secret, totpEnabled: true });

    const credentials = { email: "maria@teste.com.br", password: "Segredo#123" };
    // Sem código e com código errado → bloqueado com erro dedicado.
    await expect(login(deps, credentials)).rejects.toThrow(/duas etapas/);
    await expect(login(deps, { ...credentials, totpCode: "000000" })).rejects.toThrow(
      /duas etapas/
    );

    // Código do relógio fixo do ambiente de teste → aceito.
    const nowSeconds = Math.floor(env.clock.now().getTime() / 1000);
    const result = await login(deps, { ...credentials, totpCode: totpCode(secret, nowSeconds) });
    expect(result.user.totpEnabled).toBe(true);
    // O segredo TOTP jamais aparece na resposta (allowlist do publicUser).
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("anti-replay: o mesmo código TOTP não pode ser reutilizado", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const seeded = await seedLoginUser(env);
    const secret = generateTotpSecret();
    await env.repos.users.update({ ...seeded, totpSecret: secret, totpEnabled: true });

    const credentials = { email: "maria@teste.com.br", password: "Segredo#123" };
    const nowSeconds = Math.floor(env.clock.now().getTime() / 1000);
    const code = totpCode(secret, nowSeconds);

    // 1º uso do código: aceito.
    await login(deps, { ...credentials, totpCode: code });
    // 2º uso do MESMO código (mesma janela): rejeitado (anti-replay).
    await expect(login(deps, { ...credentials, totpCode: code })).rejects.toThrow(/duas etapas/);
    // O counter consumido foi persistido no usuário.
    const updated = await env.repos.users.getById(seeded.id);
    expect(updated?.totpLastCounter).toBe(Math.floor(nowSeconds / 30));
  });

  it("senha errada e e-mail inexistente falham com a mesma mensagem (401)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await seedLoginUser(env);

    await expect(
      login(deps, { email: "maria@teste.com.br", password: "errada" })
    ).rejects.toThrow("E-mail ou senha inválidos.");
    await expect(
      login(deps, { email: "naoexiste@teste.com.br", password: "x" })
    ).rejects.toThrow("E-mail ou senha inválidos.");
  });

  it("valida o corpo da requisição", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    await expect(login(deps, { email: "a@b.com" })).rejects.toThrow(ValidationError);
  });
});

describe("me, companies e users", () => {
  it("getMe devolve usuário sem hash, empresa e papel", async () => {
    const env = createTestEnv();
    const session = await sessionFor(env, "analyst");
    const me = getMe(session);
    expect(me.role).toBe("finance_analyst");
    expect(me.company.id).toBe(env.company.id);
    expect(JSON.stringify(me)).not.toContain("passwordHash");
  });

  it("listCompanies devolve as empresas do usuário com papel e marca a atual", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "manager");
    const companies = await listCompanies(deps, session);
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({
      id: env.company.id,
      role: "finance_manager",
      current: true,
    });
  });

  it("listCompanyUsers exige user.manage: admin lê (sem passwordHash), viewer é barrado", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);

    const admin = await sessionFor(env, "admin");
    const users = await listCompanyUsers(deps, admin);
    expect(users).toHaveLength(5);
    expect(JSON.stringify(users)).not.toContain("passwordHash");
    expect(users.find((u) => u.id === "usr_approver")?.role).toBe("approver");

    // RBAC: um viewer NÃO deve listar os usuários da empresa pela API.
    const viewer = await sessionFor(env, "viewer");
    await expect(listCompanyUsers(deps, viewer)).rejects.toThrow(PermissionError);
  });

  it("listSuppliers exige master_data.manage: analyst lê, viewer é barrado", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const analyst = await sessionFor(env, "analyst");
    await createSupplier(deps, analyst, { name: "Fornecedor X" });

    expect(await listSuppliers(deps, analyst)).toHaveLength(1);
    const viewer = await sessionFor(env, "viewer");
    await expect(listSuppliers(deps, viewer)).rejects.toThrow(PermissionError);
  });

  it("listBankAccounts exige bank_account.manage: viewer é barrado", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const viewer = await sessionFor(env, "viewer");
    await expect(listBankAccounts(deps, viewer)).rejects.toThrow(PermissionError);
  });
});

// ---------------------------------------------------------------------------
// Cadastros
// ---------------------------------------------------------------------------

describe("suppliers", () => {
  const input = {
    name: "Torrefação Alfa",
    document: "11.222.333/0001-44",
    bankInfo: "Banco 341 ag 0001 cc 987654321",
    pixKey: "financeiro@alfa.com.br",
  };

  it("cria fornecedor com dados bancários mascarados e audita", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");

    const { entity, created } = await createSupplier(deps, session, input);
    expect(created).toBe(true);
    expect(entity.bankInfoMasked?.endsWith("4321")).toBe(true);
    expect(entity.bankInfoMasked).not.toContain("98765");
    expect(entity.pixKeyMasked?.endsWith("m.br")).toBe(true);
    expect(JSON.stringify(entity)).not.toContain("987654321");

    const audit = await env.repos.audit.list(env.company.id, {
      entityType: "supplier",
      entityId: entity.id,
    });
    expect(audit.map((a) => a.action)).toContain("supplier.created");
    expect(JSON.stringify(audit)).not.toContain("987654321");
  });

  it("persiste classificação de custo e categoria (categoria em Title Case)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");

    const { entity } = await createSupplier(deps, session, {
      name: "Fornecedor Beta",
      document: "22.333.444/0001-55",
      costClassification: "fixed",
      category: "material de escritório",
    });
    expect(entity.costClassification).toBe("fixed");
    expect(entity.category).toBe("Material De Escritório");
  });

  it("é idempotente por documento: repetir o POST não duplica", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");

    const first = await createSupplier(deps, session, input);
    const second = await createSupplier(deps, session, input);
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(await listSuppliers(deps, session)).toHaveLength(1);
  });

  it("viewer não pode criar (permission_denied) e entrada inválida falha", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const viewer = await sessionFor(env, "viewer");
    await expect(createSupplier(deps, viewer, input)).rejects.toThrow(PermissionError);

    const analyst = await sessionFor(env, "analyst");
    await expect(createSupplier(deps, analyst, { name: "" })).rejects.toThrow(ValidationError);
  });
});

describe("bank-accounts", () => {
  const input = {
    name: "Conta Movimento",
    bankCode: "341",
    agency: "0001",
    accountNumber: "987654-3",
    type: "checking" as const,
    openingBalanceCents: 1_500_000,
    openingBalanceDate: "2026-01-01",
  };

  it("cria conta com número mascarado (exige bank_account.manage)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "manager");

    const { entity, created } = await createBankAccount(deps, session, input);
    expect(created).toBe(true);
    expect(entity.accountNumberMasked).toBe("****54-3");
    expect(JSON.stringify(entity)).not.toContain("987654-3");
    expect(entity.openingBalanceCents).toBe(1_500_000);

    // Replay idempotente pela chave natural banco+agência+número mascarado.
    const replay = await createBankAccount(deps, session, input);
    expect(replay.created).toBe(false);
    expect(replay.entity.id).toBe(entity.id);
  });

  it("finance_analyst não possui bank_account.manage → 403", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");
    await expect(createBankAccount(deps, session, input)).rejects.toThrow(PermissionError);
  });

  it("valida data e centavos inteiros", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "manager");
    await expect(
      createBankAccount(deps, session, { ...input, openingBalanceDate: "01/01/2026" })
    ).rejects.toThrow(ValidationError);
    await expect(
      createBankAccount(deps, session, { ...input, openingBalanceCents: 10.5 })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Títulos
// ---------------------------------------------------------------------------

describe("payables", () => {
  it("lista com filtros de status e vencimento, ordenada por dueDate", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    await seedPayable(env, { dueDate: "2026-08-25", status: "open" });
    await seedPayable(env, { dueDate: "2026-08-10", status: "open" });
    await seedPayable(env, { dueDate: "2026-08-15", status: "paid", paidCents: 100_000 });

    const all = await listPayables(deps, session, {});
    expect(all.items.map((p) => p.dueDate)).toEqual(["2026-08-10", "2026-08-15", "2026-08-25"]);
    expect(all.total).toBe(3);

    const open = await listPayables(deps, session, { status: "open" });
    expect(open.items).toHaveLength(2);

    const window = await listPayables(deps, session, { from: "2026-08-11", to: "2026-08-26" });
    expect(window.items.map((p) => p.dueDate)).toEqual(["2026-08-15", "2026-08-25"]);
    expect(window.total).toBe(2);

    // Paginação: limit/offset com total estável e ordem determinística.
    const page1 = await listPayables(deps, session, { limit: "2", offset: "0" });
    const page2 = await listPayables(deps, session, { limit: "2", offset: "2" });
    expect(page1.items.map((p) => p.dueDate)).toEqual(["2026-08-10", "2026-08-15"]);
    expect(page2.items.map((p) => p.dueDate)).toEqual(["2026-08-25"]);
    expect(page1.total).toBe(3);
    expect(page1.limit).toBe(2);
    await expect(listPayables(deps, session, { limit: "500" })).rejects.toThrow(ValidationError);
  });

  it("rejeita status e datas inválidos", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    await expect(listPayables(deps, session, { status: "invalido" })).rejects.toThrow(
      ValidationError
    );
    await expect(listPayables(deps, session, { from: "2026-13-01" })).rejects.toThrow(
      ValidationError
    );
  });

  it("detalhe devolve pagamentos do título; inexistente → not_found", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    const payable = await seedPayable(env, {});
    const now = env.clock.now().toISOString();
    await env.repos.payments.create({
      id: "pmt_1",
      companyId: env.company.id,
      payableId: payable.id,
      bankAccountId: "acc_1",
      amountCents: 100_000,
      scheduledDate: "2026-08-20",
      status: "pending_approval",
      requestedBy: "usr_analyst",
      createdAt: now,
      updatedAt: now,
    });

    const detail = await getPayable(deps, session, payable.id);
    expect(detail.payable.id).toBe(payable.id);
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0].amountCents).toBe(100_000);

    await expect(getPayable(deps, session, "pay_nao_existe")).rejects.toThrow(NotFoundError);
  });
});

describe("bank-transactions", () => {
  it("filtra por conta e por conciliação", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst"); // reconciliation.manage
    const now = env.clock.now().toISOString();
    const base = {
      companyId: env.company.id,
      currency: "BRL" as const,
      source: "ofx" as const,
      createdAt: now,
    };
    await env.repos.bankTransactions.create({
      ...base,
      id: "btx_1",
      bankAccountId: "acc_1",
      date: "2026-08-10",
      amountCents: 50_000,
      description: "PIX recebido",
      reconciled: true,
    });
    await env.repos.bankTransactions.create({
      ...base,
      id: "btx_2",
      bankAccountId: "acc_2",
      date: "2026-08-11",
      amountCents: -20_000,
      description: "Tarifa",
      reconciled: false,
    });

    const byAccount = await listBankTransactions(deps, session, { accountId: "acc_1" });
    expect(byAccount.items.map((t) => t.id)).toEqual(["btx_1"]);

    const unreconciled = await listBankTransactions(deps, session, { reconciled: "false" });
    expect(unreconciled.items.map((t) => t.id)).toEqual(["btx_2"]);

    await expect(listBankTransactions(deps, session, { reconciled: "sim" })).rejects.toThrow(
      ValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// Fluxos e aprovações
// ---------------------------------------------------------------------------

describe("flows", () => {
  it("lista os fluxos com passos e permissão exigida (contrato público)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const flows = listFlows(deps);
    const names = flows.map((f) => f.name);
    expect(names).toContain("supplier_invoice_intake");
    expect(names).toContain("bank_statement_import");

    const daily = flows.find((f) => f.name === "daily_summary");
    expect(daily?.requiredPermission).toBe("report.view");
    expect(daily?.steps.every((s) => Object.keys(s).sort().join(",") === "description,id,skill")).toBe(
      true
    );
  });

  it("executa fluxo, devolve OrchestratorResponse e faz replay idempotente", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");

    const res = await executeFlow(deps, session, "daily_summary", {
      payload: {},
      idempotencyKey: "req-daily-1",
    });
    expect(res.status).toBe("completed");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.consolidated.summary).toContain("concluído");

    const replay = await executeFlow(deps, session, "daily_summary", {
      payload: {},
      idempotencyKey: "req-daily-1",
    });
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.flowRunId).toBe(res.flowRunId);
  });

  it("fluxo desconhecido e corpo inválido → validation_error", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");
    await expect(executeFlow(deps, session, "nao_existe", { payload: {} })).rejects.toThrow(
      ValidationError
    );
    await expect(
      executeFlow(deps, session, "daily_summary", { idempotencyKey: 123 })
    ).rejects.toThrow(ValidationError);
  });
});

describe("approvals", () => {
  async function suspendPaymentFlow(env: TestEnv, deps: ApiDeps) {
    const analyst = await sessionFor(env, "analyst");
    const res = await executeFlow(deps, analyst, "schedule_payment", {
      payload: {
        payableId: "pay_x",
        bankAccountId: "acc_1",
        scheduledDate: "2026-08-20",
      },
    });
    expect(res.status).toBe("awaiting_approval");
    expect(res.approval?.status).toBe("pending");
    return res;
  }

  it("aprovar retoma o fluxo suspenso e devolve a resposta consolidada", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const res = await suspendPaymentFlow(env, deps);

    const approver = await sessionFor(env, "approver");
    const resumed = (await decideApproval(deps, approver, res.approval!.id, {
      decision: "approved",
      justification: "dentro da alçada",
    })) as OrchestratorResponse;

    expect(resumed.status).toBe("completed");
    const step = resumed.results.find((r) => r.stepId === "ap_schedule");
    expect(step?.result.data).toMatchObject({ decidedBy: "usr_approver" });

    const stored = await env.repos.approvals.getById(env.company.id, res.approval!.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.decidedBy).toBe("usr_approver");
  });

  it("rejeitar cancela a ação pendente", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const res = await suspendPaymentFlow(env, deps);

    const approver = await sessionFor(env, "approver");
    const resumed = (await decideApproval(deps, approver, res.approval!.id, {
      decision: "rejected",
      justification: "fora de política",
    })) as OrchestratorResponse;

    expect(resumed.status).toBe("rejected");
    const stored = await env.repos.approvals.getById(env.company.id, res.approval!.id);
    expect(stored?.status).toBe("rejected");
  });

  it("segregação de funções: solicitante não decide a própria aprovação", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const res = await suspendPaymentFlow(env, deps);

    const analyst = await sessionFor(env, "analyst");
    await expect(
      decideApproval(deps, analyst, res.approval!.id, { decision: "approved" })
    ).rejects.toThrow(SegregationError);
  });

  it("aprovação inexistente → not_found; decisão inválida → validation_error", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const approver = await sessionFor(env, "approver");
    await expect(
      decideApproval(deps, approver, "apr_nao_existe", { decision: "approved" })
    ).rejects.toThrow(NotFoundError);
    await expect(
      decideApproval(deps, approver, "apr_x", { decision: "talvez" })
    ).rejects.toThrow(ValidationError);
  });
});

describe("alerts", () => {
  it("ack marca como acknowledged com auditoria e é idempotente", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "manager");
    await env.repos.alerts.create({
      id: "alr_1",
      companyId: env.company.id,
      severity: "warning",
      code: "cash_low",
      message: "Caixa abaixo do mínimo.",
      source: "tesouraria_fluxo_caixa",
      status: "open",
      createdAt: env.clock.now().toISOString(),
    });

    const first = await acknowledgeAlert(deps, session, "alr_1");
    expect(first.created).toBe(true);
    expect(first.entity.status).toBe("acknowledged");

    const second = await acknowledgeAlert(deps, session, "alr_1");
    expect(second.created).toBe(false);
    expect(second.entity.status).toBe("acknowledged");

    const audit = await env.repos.audit.list(env.company.id, {
      entityType: "alert",
      entityId: "alr_1",
    });
    expect(audit.filter((a) => a.action === "alert.acknowledged")).toHaveLength(1);

    const acked = await listAlerts(deps, session, { status: "acknowledged" });
    expect(acked.map((a) => a.id)).toEqual(["alr_1"]);
  });

  it("alerta inexistente → not_found", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "manager");
    await expect(acknowledgeAlert(deps, session, "alr_zz")).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Auditoria, skills e importação
// ---------------------------------------------------------------------------

describe("audit, skills e import", () => {
  it("trilha de auditoria filtra por entidade e exige audit.view", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const manager = await sessionFor(env, "manager");
    await createSupplier(deps, manager, { name: "Fornecedor Auditado" });

    const records = await getAuditTrail(deps, manager, { entityType: "supplier" });
    expect(records.items.length).toBeGreaterThan(0);
    expect(records.items.every((r) => r.entityType === "supplier")).toBe(true);
    expect(records.total).toBe(records.items.length);

    const analyst = await sessionFor(env, "analyst"); // finance_analyst não tem audit.view
    await expect(getAuditTrail(deps, analyst, {})).rejects.toThrow(PermissionError);
  });

  it("catálogo de skills expõe apenas o contrato público", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const skills = listSkills(deps);
    expect(skills).toHaveLength(SKILL_NAMES.length);
    const ap = skills.find((s) => s.name === "contas_a_pagar");
    expect(ap).toBeDefined();
    expect(Object.keys(ap!).sort()).toEqual([
      "consumes",
      "dataSources",
      "name",
      "objective",
      "publishes",
      "responsibility",
    ]);
  });

  it("import/statement dispara o fluxo bank_statement_import", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "analyst");
    const res = await importStatement(deps, session, {
      bankAccountId: "acc_1",
      format: "ofx",
      content: "<OFX>...</OFX>",
    });
    expect(res.flow).toBe("bank_statement_import");
    expect(res.status).toBe("completed");
  });

  it("import valida entrada e permissão (viewer não concilia)", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const analyst = await sessionFor(env, "analyst");
    await expect(
      importStatement(deps, analyst, { bankAccountId: "acc_1", format: "xml", content: "x" })
    ).rejects.toThrow(ValidationError);

    const viewer = await sessionFor(env, "viewer");
    await expect(
      importStatement(deps, viewer, { bankAccountId: "acc_1", format: "ofx", content: "x" })
    ).rejects.toThrow(PermissionError);
  });
});

// ---------------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------------

describe("reports", () => {
  it("format=json devolve o envelope SkillResult da ação do relatório", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer"); // report.view basta
    const out = await runReport(deps, session, "daily_summary", {});
    expect(out.kind).toBe("json");
    if (out.kind === "json") {
      expect(out.result.skill).toBe("relatorios_gerenciais");
      expect(out.result.status).toBe("success");
      expect(out.result.data).toMatchObject({ action: "daily_summary", ok: true });
    }
  });

  it("reconciliation_audit vem da skill de CONCILIAÇÃO, não da de relatórios", async () => {
    const env = createTestEnv();
    // Registry REAL: o que se prova aqui é que o mapa de despacho acha a skill
    // certa. Com o registry de dublês, qualquer nome "funcionaria".
    const deps = buildDeps(env, buildRegistry());
    const session = await sessionFor(env, "viewer");

    const out = await runReport(deps, session, "reconciliation_audit", { period: "2026-08" });

    expect(out.kind).toBe("json");
    if (out.kind === "json") {
      // Sem o mapa de despacho, isto morreria na validação da skill errada.
      expect(out.result.skill).toBe("conciliacao_bancaria");
      expect(out.result.status).toBe("success");
      expect(out.result.data).toMatchObject({ period: { start: "2026-08-01", end: "2026-08-31" } });
    }
  });

  it("reconciliation_audit exige period", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env, buildRegistry());
    const session = await sessionFor(env, "viewer");

    await expect(runReport(deps, session, "reconciliation_audit", {})).rejects.toThrow(
      /exige o parâmetro period/
    );
  });

  it("reconciliation_audit exporta UMA LINHA POR DIVERGÊNCIA, com coluna tipo", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env, buildRegistry());
    const session = await sessionFor(env, "viewer");
    const agora = env.clock.now().toISOString();

    env.db.bankAccounts.push({
      id: "ba_rel",
      companyId: env.company.id,
      name: "Itaú",
      bankCode: "341",
      agency: "0001",
      accountNumberMasked: "****0135",
      type: "checking",
      currency: "BRL",
      openingBalanceCents: 0,
      openingBalanceDate: "2026-08-01",
      active: true,
      createdAt: agora,
      updatedAt: agora,
    });
    env.db.bankTransactions.push({
      id: "btx_rel",
      companyId: env.company.id,
      bankAccountId: "ba_rel",
      date: "2026-08-14",
      amountCents: -12_000,
      currency: "BRL",
      description: "TARIFA PACOTE SERVICOS",
      source: "ofx",
      reconciled: false,
      createdAt: agora,
    });

    const csv = await runReport(deps, session, "reconciliation_audit", {
      period: "2026-08",
      format: "csv",
    });

    expect(csv.kind).toBe("csv");
    if (csv.kind === "csv") {
      expect(csv.filename).toBe("reconciliation_audit-2026-08.csv");
      // O CSV sai com BOM UTF-8 e separador ";" (padrao do exportador).
      expect(csv.content.replace(/^﻿/, "").startsWith("tipo;data;descricao")).toBe(true);
      expect(csv.content).toContain("Extrato sem explicação");
      expect(csv.content).toContain("TARIFA PACOTE SERVICOS");
    }

    const xlsx = await runReport(deps, session, "reconciliation_audit", {
      period: "2026-08",
      format: "xlsx",
    });
    expect(xlsx.kind).toBe("xlsx");
    if (xlsx.kind === "xlsx") {
      expect(xlsx.filename).toBe("reconciliation_audit-2026-08.xlsx");
      expect(xlsx.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("monthly_close exige period; relatório e formato desconhecidos falham", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    await expect(runReport(deps, session, "monthly_close", {})).rejects.toThrow(
      /exige o parâmetro period/
    );
    await expect(runReport(deps, session, "inexistente", {})).rejects.toThrow(ValidationError);
    await expect(
      runReport(deps, session, "daily_summary", { format: "doc" })
    ).rejects.toThrow(ValidationError);
    await expect(
      runReport(deps, session, "monthly_close", { period: "2026/07" })
    ).rejects.toThrow(ValidationError);
  });

  it("monthly_close com period repassa o período à skill", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    const out = await runReport(deps, session, "monthly_close", { period: "2026-07" });
    expect(out.kind).toBe("json");
    if (out.kind === "json") {
      expect(out.result.data).toMatchObject({ action: "monthly_close", period: "2026-07" });
    }
  });

  it.skipIf(!exportersAvailable)(
    "format=csv exporta as linhas metrica/valor/unidade/fonte",
    async () => {
      const env = createTestEnv();
      const deps = buildDeps(env);
      const session = await sessionFor(env, "viewer");
      const out = await runReport(deps, session, "daily_summary", { format: "csv" });
      expect(out.kind).toBe("csv");
      if (out.kind === "csv") {
        expect(out.filename).toBe("daily_summary.csv");
        expect(out.content).toContain("metrica");
        expect(out.content).toContain("saldo_caixa");
        expect(out.content).toContain("titulos_vencidos");
      }
    }
  );

  it.skipIf(!exportersAvailable)("format=xlsx devolve um pacote Excel válido", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    const out = await runReport(deps, session, "daily_summary", { format: "xlsx" });
    expect(out.kind).toBe("xlsx");
    if (out.kind === "xlsx") {
      expect(out.filename).toBe("daily_summary.xlsx");
      // Assinatura ZIP (PK\x03\x04) e a worksheet dentro do pacote (modo STORE).
      expect([out.bytes[0], out.bytes[1], out.bytes[2], out.bytes[3]]).toEqual([
        0x50, 0x4b, 0x03, 0x04,
      ]);
      const text = Buffer.from(out.bytes).toString("utf8");
      expect(text).toContain("xl/worksheets/sheet1.xml");
      expect(text).toContain("saldo_caixa");
    }
  });

  it.skipIf(!exportersAvailable)("format=pdf devolve um PDF válido", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env);
    const session = await sessionFor(env, "viewer");
    const out = await runReport(deps, session, "monthly_close", {
      format: "pdf",
      period: "2026-07",
    });
    expect(out.kind).toBe("pdf");
    if (out.kind === "pdf") {
      expect(out.filename).toBe("monthly_close-2026-07.pdf");
      expect(out.bytes.length).toBeGreaterThan(0);
      const header = new TextDecoder().decode(out.bytes.slice(0, 4));
      expect(header).toBe("%PDF");
    }
  });
});

describe("accounting/export (lote contábil no layout escolhido)", () => {
  // Registro com a skill contábil REAL (o lote é dela) e fakes no restante.
  function registryWithRealContabil(): SkillRegistry {
    const registry = new SkillRegistry();
    for (const name of SKILL_NAMES) {
      if (name === "integracao_contabil_fiscal") registry.register(contabilSkill);
      else if (name === "contas_a_pagar") registry.register(fakeContasAPagar());
      else registry.register(fakeSkill(name));
    }
    return registry;
  }

  function seedEntry(env: TestEnv): void {
    env.db.accountingEntries.push({
      id: "ae_api_1",
      companyId: env.company.id,
      entryDate: "2026-08-10",
      debitAccount: "4.2",
      creditAccount: "1.1",
      amountCents: 15_000,
      memo: "Energia elétrica",
      sourceType: "payment",
      sourceId: "pay_api_1",
      exported: false,
      createdAt: env.clock.now().toISOString(),
    });
  }

  it("gera o arquivo no layout escolhido e repetir devolve o MESMO lote", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env, registryWithRealContabil());
    const session = await sessionFor(env, "manager");
    seedEntry(env);

    const file = await exportAccountingBatch(deps, session, { period: "2026-08", layout: "omie" });
    expect(file).toMatchObject({
      filename: "lancamentos-2026-08-omie.csv",
      layoutId: "omie",
      count: 1,
      period: "2026-08",
    });
    expect(file.contentType).toContain("text/csv");
    const lines = file.content.split("\n");
    expect(lines[0]).toBe("Data;Conta Débito;Conta Crédito;Valor;Histórico;Origem");
    expect(lines[1]).toBe("10/08/2026;4.2;1.1;150,00;Energia elétrica;payment:pay_api_1");

    // Idempotência de requisição do orquestrador: mesmo lote, nada reprocessado.
    const again = await exportAccountingBatch(deps, session, { period: "2026-08", layout: "omie" });
    expect(again.content).toBe(file.content);
    expect(again.batchId).toBe(file.batchId);
  });

  it("layout TXT (dominio) devolve text/plain; permissão e entrada são validadas", async () => {
    const env = createTestEnv();
    const deps = buildDeps(env, registryWithRealContabil());
    const session = await sessionFor(env, "manager");
    seedEntry(env);

    const file = await exportAccountingBatch(deps, session, {
      period: "2026-08",
      layout: "dominio",
    });
    expect(file.filename).toBe("lancamentos-2026-08-dominio.txt");
    expect(file.contentType).toContain("text/plain");

    const viewer = await sessionFor(env, "viewer");
    await expect(
      exportAccountingBatch(deps, viewer, { period: "2026-08" })
    ).rejects.toThrow(/permissão/);
    await expect(
      exportAccountingBatch(deps, session, { period: "08/2026" })
    ).rejects.toThrow(ValidationError);
  });
});
