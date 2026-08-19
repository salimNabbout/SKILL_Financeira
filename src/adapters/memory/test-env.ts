/**
 * Ambiente de teste compartilhado — usado pelos testes unitários e de
 * integração de todas as skills. Determinístico: relógio fixo, IDs sequenciais.
 */

import { HeuristicClassifier } from "@/core/ai";
import { HashChainAuditTrail } from "@/core/audit";
import { FixedClock } from "@/core/clock";
import { DEFAULT_COMPANY_CONFIG, type CompanyConfig } from "@/core/config";
import { todayInTz } from "@/core/dates";
import type { Actor, Company, Membership, RoleName, User } from "@/core/entities";
import { InMemoryEventBus } from "@/core/events";
import { SequentialIdGenerator } from "@/core/ids";
import type { Integrations } from "@/core/integrations";
import { buildIntegrations } from "@/integrations/registry";
import { Orchestrator } from "@/core/orchestrator/orchestrator";
import type { SkillRegistry } from "@/core/orchestrator/registry";
import type { Repositories } from "@/core/repositories";
import type { SkillContext } from "@/core/skill";
import { MemoryDb } from "./db";
import { createMemoryRepositories } from "./repos";

export interface TestEnv {
  db: MemoryDb;
  repos: Repositories;
  events: InMemoryEventBus;
  audit: HashChainAuditTrail;
  clock: FixedClock;
  ids: SequentialIdGenerator;
  ai: HeuristicClassifier;
  integrations: Integrations;
  config: CompanyConfig;
  company: Company;
  users: Record<"admin" | "manager" | "analyst" | "approver" | "viewer", User>;
  /** Cria um SkillContext para o ator informado (default: analista). */
  ctx(actor?: Actor): SkillContext;
  /** Cria um orquestrador com o registro de skills informado. */
  orchestrator(registry: SkillRegistry): Orchestrator;
  actorFor(key: "admin" | "manager" | "analyst" | "approver" | "viewer"): Actor;
}

const ROLES: Record<string, { role: RoleName; limit: number | null }> = {
  admin: { role: "admin", limit: null },
  manager: { role: "finance_manager", limit: 5_000_000 },
  analyst: { role: "finance_analyst", limit: 0 },
  approver: { role: "approver", limit: 500_000 },
  viewer: { role: "viewer", limit: 0 },
};

export function createTestEnv(nowIso = "2026-08-18T15:00:00Z"): TestEnv {
  const db = new MemoryDb();
  const repos = createMemoryRepositories(db);
  const clock = new FixedClock(nowIso);
  const ids = new SequentialIdGenerator();
  const events = new InMemoryEventBus(repos.events, clock, ids);
  const audit = new HashChainAuditTrail(repos.audit, clock, ids);
  const ai = new HeuristicClassifier();
  const integrations = buildIntegrations({}); // mocks determinísticos
  const config = DEFAULT_COMPANY_CONFIG;
  const now = clock.now().toISOString();

  const company: Company = {
    id: "co_teste",
    name: "PME Teste Ltda",
    cnpj: "12.345.678/0001-90",
    timezone: "America/Sao_Paulo",
    defaultCurrency: "BRL",
    config,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  db.companies.push(company);

  const users = {} as TestEnv["users"];
  for (const [key, { role, limit }] of Object.entries(ROLES)) {
    const user: User = {
      id: `usr_${key}`,
      name: `Usuário ${key}`,
      email: `${key}@teste.com.br`,
      passwordHash: "x",
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    db.users.push(user);
    const membership: Membership = {
      id: `mem_${key}`,
      userId: user.id,
      companyId: company.id,
      role,
      approvalLimitCents: limit,
    };
    db.memberships.push(membership);
    users[key as keyof TestEnv["users"]] = user;
  }

  const actorFor = (key: keyof typeof ROLES): Actor => ({
    type: "user",
    id: `usr_${key}`,
    role: ROLES[key].role,
  });

  const ctx = (actor: Actor = actorFor("analyst")): SkillContext => ({
    companyId: company.id,
    actor,
    repos,
    events,
    audit,
    clock,
    ids,
    config,
    ai,
    integrations,
    correlationId: "corr_test",
    today: () => todayInTz(clock.now(), config.timezone),
  });

  const orchestrator = (registry: SkillRegistry) =>
    new Orchestrator({ repos, events, clock, ids, ai, integrations, registry });

  return {
    db,
    repos,
    events,
    audit,
    clock,
    ids,
    ai,
    integrations,
    config,
    company,
    users,
    ctx,
    orchestrator,
    actorFor: actorFor as TestEnv["actorFor"],
  };
}
