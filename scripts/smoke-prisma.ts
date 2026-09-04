/**
 * Smoke do adaptador Prisma contra um PostgreSQL REAL (usado no CI).
 * Percorre o caminho completo de produção: repositórios Prisma + orquestrador +
 * skills reais — criação de título (4 skills), idempotência, aprovação humana
 * com segregação de funções, execução (mock) e trilha de auditoria íntegra.
 *
 * Pré-requisitos: DATABASE_URL apontando para um banco migrado e semeado
 * (prisma migrate deploy + npm run db:seed). Sai com código 1 em qualquer falha.
 *
 * Imports relativos (sem alias @/): roda via tsx fora do Next.
 */

import { PrismaClient } from "@prisma/client";

import { DEMO_COMPANY_ID } from "../src/adapters/memory/demo-seed";
import { createPrismaRepositories } from "../src/adapters/prisma/repos";
import { HeuristicClassifier } from "../src/core/ai";
import { verifyChain } from "../src/core/audit";
import { SystemClock } from "../src/core/clock";
import { addDays, todayInTz } from "../src/core/dates";
import type { Actor } from "../src/core/entities";
import { InMemoryEventBus } from "../src/core/events";
import { RandomIdGenerator } from "../src/core/ids";
import {
  Orchestrator,
  type OrchestratorResponse,
} from "../src/core/orchestrator/orchestrator";
import { buildIntegrations } from "../src/integrations/registry";
import { buildRegistry } from "../src/skills";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FALHA: ${message}`);
  console.log(`  ✓ ${message}`);
}

const CARLA: Actor = { type: "user", id: "usr_carla", role: "finance_analyst" };
const DIEGO: Actor = { type: "user", id: "usr_diego", role: "approver" };

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const repos = createPrismaRepositories(prisma);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const events = new InMemoryEventBus(repos.events, clock, ids);
  const orchestrator = new Orchestrator({
    repos,
    events,
    clock,
    ids,
    ai: new HeuristicClassifier(),
    integrations: buildIntegrations({}),
    registry: buildRegistry(),
  });

  const today = todayInTz(clock.now(), "America/Sao_Paulo");
  // Sufixo único por execução: o smoke pode rodar mais de uma vez no mesmo banco.
  const runTag = `smoke-${Date.now()}`;

  console.log("\n1) Fluxo integrado: nota de fornecedor (AP → Controles → Tesouraria → Orçamento)");
  const intakeRequest = {
    flow: "supplier_invoice_intake",
    companyId: DEMO_COMPANY_ID,
    actor: CARLA,
    payload: {
      supplierId: "sup_torrefacao",
      description: `Smoke CI — NF ${runTag}`,
      issueDate: today,
      dueDate: addDays(today, 20),
      amountCents: 130_000,
      categoryId: "cat_insumos",
      document: {
        type: "nfe",
        number: runTag,
        issuedAt: today,
        totalCents: 130_000,
      },
    },
    idempotencyKey: `${runTag}-intake`,
  };
  const intake = await orchestrator.execute(intakeRequest);
  assert(intake.status === "completed", `fluxo concluído (status: ${intake.status})`);
  assert(intake.results.length === 4, `4 passos executados (${intake.results.length})`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payable = (intake.results[0].result.data as any)?.payables?.[0];
  assert(payable?.id, "título criado no PostgreSQL");
  const persisted = await repos.payables.getById(DEMO_COMPANY_ID, payable.id);
  assert(persisted?.amountCents === 130_000, "valor persistido e relido corretamente (BigInt↔centavos)");

  console.log("\n2) Idempotência: mesma requisição não duplica");
  const replay = await orchestrator.execute(intakeRequest);
  assert(replay.idempotent_replay === true, "replay atendido pelo cache de idempotência");
  const byOrigin = await repos.payables.findByOriginKey(DEMO_COMPANY_ID, persisted!.originKey);
  assert(byOrigin?.id === payable.id, "nenhum título duplicado (originKey única)");

  console.log("\n3) Pagamento com aprovação humana (alçada + segregação)");
  const schedule = await orchestrator.execute({
    flow: "schedule_payment",
    companyId: DEMO_COMPANY_ID,
    actor: CARLA,
    payload: {
      payableId: payable.id,
      bankAccountId: "ba_itau",
      scheduledDate: addDays(today, 1),
      method: "pix",
    },
    idempotencyKey: `${runTag}-pay`,
  });
  assert(schedule.status === "awaiting_approval", "fluxo suspenso aguardando aprovação");
  assert(schedule.approval?.requiredRole === "approver", "alçada correta (R$ 1.300 → aprovador)");

  let selfApprovalBlocked = false;
  try {
    await orchestrator.decideApproval({
      companyId: DEMO_COMPANY_ID,
      approvalId: schedule.approval!.id,
      decision: "approved",
      actor: CARLA,
    });
  } catch {
    selfApprovalBlocked = true;
  }
  assert(selfApprovalBlocked, "segregação de funções: solicitante não aprova a própria solicitação");

  const resumed = (await orchestrator.decideApproval({
    companyId: DEMO_COMPANY_ID,
    approvalId: schedule.approval!.id,
    decision: "approved",
    actor: DIEGO,
    justification: "smoke CI",
  })) as OrchestratorResponse;
  assert(resumed.status === "completed", `fluxo retomado e concluído (${resumed.status})`);

  const payments = await repos.payments.listByPayable(DEMO_COMPANY_ID, payable.id);
  const executed = payments.filter((p) => p.status === "executed");
  assert(executed.length === 1, "pagamento executado (mock) persistido");
  assert(executed[0].executedBy === DIEGO.id, "executor registrado = aprovador");
  const paidPayable = await repos.payables.getById(DEMO_COMPANY_ID, payable.id);
  assert(paidPayable?.status === "paid", "título baixado como pago");

  const entries = await repos.accountingEntries.listAll(DEMO_COMPANY_ID);
  assert(
    entries.some((e) => e.sourceType === "payment" && e.sourceId === executed[0].id),
    "lançamento contábil de partida dobrada preparado"
  );

  console.log("\n4) Governança persistida");
  const audit = await repos.audit.list(DEMO_COMPANY_ID);
  const chain = verifyChain(audit);
  assert(chain.valid, `trilha de auditoria íntegra (${audit.length} registros, hash-chain válida)`);
  const outbox = await repos.events.list(DEMO_COMPANY_ID);
  assert(outbox.length > 0, `outbox de eventos populado (${outbox.length} eventos)`);

  console.log("\n5) Paginação no banco real");
  const p1 = await repos.payables.listPage(DEMO_COMPANY_ID, { offset: 0, limit: 3 });
  const p2 = await repos.payables.listPage(DEMO_COMPANY_ID, { offset: 3, limit: 3 });
  assert(p1.items.length === 3 && p1.total >= 4, `página 1 com 3 itens de ${p1.total}`);
  assert(
    p1.items.every((a) => !p2.items.some((b) => b.id === a.id)),
    "páginas sem sobreposição (ordem determinística por vencimento)"
  );
  const auditPage = await repos.audit.listPage(DEMO_COMPANY_ID, { offset: 0, limit: 5 });
  assert(
    auditPage.items.length > 0 &&
      auditPage.items.every((r, i, arr) => i === 0 || arr[i - 1].seq > r.seq),
    "auditoria paginada em ordem seq desc"
  );

  // --- Trilha append-only NO BANCO (migration 0018) ------------------------
  // O contrato existia so no codigo; agora ha gatilho na tabela. Este bloco
  // prova que UPDATE e DELETE falham mesmo com SQL direto.
  const alvoAudit = auditPage.items[0];
  const barrado = async (sql: string, ...args: unknown[]): Promise<boolean> => {
    try {
      await prisma.$executeRawUnsafe(sql, ...args);
      return false;
    } catch {
      return true;
    }
  };

  assert(
    await barrado(`UPDATE "AuditRecord" SET "action" = 'adulterado' WHERE "id" = $1`, alvoAudit.id),
    "UPDATE em AuditRecord e bloqueado pelo gatilho"
  );
  assert(
    await barrado(`DELETE FROM "AuditRecord" WHERE "id" = $1`, alvoAudit.id),
    "DELETE em AuditRecord e bloqueado pelo gatilho"
  );
  assert(
    await barrado(`DELETE FROM "AuditHead" WHERE "companyId" = $1`, DEMO_COMPANY_ID),
    "DELETE em AuditHead e bloqueado pelo gatilho"
  );
  assert(
    await barrado(`UPDATE "AuditHead" SET "seq" = 1 WHERE "companyId" = $1`, DEMO_COMPANY_ID),
    "AuditHead.seq nao pode retroceder (anti-truncamento do fim)"
  );

  const depoisDasTentativas = await repos.audit.listPage(DEMO_COMPANY_ID, { offset: 0, limit: 1 });
  assert(
    depoisDasTentativas.items[0]?.id === alvoAudit.id,
    "registro de auditoria permanece intacto"
  );

  await prisma.$disconnect();
  console.log("\nSmoke Prisma/PostgreSQL: TUDO OK ✅\n");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  console.error("Smoke Prisma/PostgreSQL: FALHOU ❌");
  process.exit(1);
});
