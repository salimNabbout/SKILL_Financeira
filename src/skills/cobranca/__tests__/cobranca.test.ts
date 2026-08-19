import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Customer, Receipt, Receivable } from "@/core/entities";
import { formatBRL } from "@/core/money";
import { runSkill } from "@/core/skill";
import {
  cobrancaSkill,
  type DelinquencyIndicatorsData,
  type RunDunningData,
  type SegmentCustomersData,
  type SuggestRenegotiationData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.
const TODAY = "2026-08-18";

let seedSeq = 0;

function seedCustomer(env: TestEnv, over: Partial<Customer> = {}): Customer {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `cli_seed_${++seedSeq}`;
  const customer: Customer = {
    id,
    companyId: env.company.id,
    name: `Cliente ${id}`,
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.customers.push(customer);
  return customer;
}

function seedReceivable(env: TestEnv, over: Partial<Receivable> = {}): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `rcv_seed_${++seedSeq}`;
  const receivable: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cli_1",
    description: "Título semeado",
    issueDate: "2026-06-01",
    dueDate: "2026-08-10",
    amountCents: 100_000,
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}:1/1`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.receivables.push(receivable);
  return receivable;
}

function seedReceipt(env: TestEnv, over: Partial<Receipt> = {}): Receipt {
  const now = env.clock.now().toISOString();
  const receipt: Receipt = {
    id: `rcp_seed_${++seedSeq}`,
    companyId: env.company.id,
    receivableId: "rcv_qualquer",
    amountCents: 50_000,
    receivedDate: "2026-07-01",
    method: "pix",
    registeredBy: "usr_analyst",
    createdAt: now,
    ...over,
  };
  env.db.receipts.push(receipt);
  return receipt;
}

async function run(env: TestEnv, input: unknown) {
  return runSkill(cobrancaSkill, env.ctx(env.actorFor("analyst")), input);
}

/** Simula a retomada pós-decisão: grava a Approval no repositório e reexecuta com ctx.approval. */
async function decideDunning(
  env: TestEnv,
  status: "approved" | "rejected",
  opts: { decidedBy?: string; justification?: string; approvalId?: string } = {}
) {
  const decidedBy = opts.decidedBy ?? "usr_approver";
  const now = env.clock.now().toISOString();
  let approvalId = opts.approvalId;
  if (!approvalId) {
    approvalId = env.ids.next("apr");
    await env.repos.approvals.create({
      id: approvalId,
      companyId: env.company.id,
      targetType: "collection_message",
      targetId: "corr_test",
      summary: "Aprovação de envio de cobrança (teste)",
      amountCents: undefined,
      requestedBy: "usr_analyst",
      requiredRole: "approver",
      status,
      decidedBy,
      decidedAt: now,
      createdAt: now,
    });
  }
  const ctx = {
    ...env.ctx(env.actorFor("analyst")),
    approval: { id: approvalId, status, decidedBy, justification: opts.justification },
  };
  const res = await runSkill(cobrancaSkill, ctx, { action: "run_dunning" });
  return { res, data: res.data as RunDunningData, approvalId };
}

// ---------------------------------------------------------------------------
// segment_customers
// ---------------------------------------------------------------------------

describe("cobranca_inadimplencia — segment_customers", () => {
  it("segmenta clientes por bucket de atraso e risco, ignorando títulos não vencidos", async () => {
    const env = createTestEnv();
    seedCustomer(env, { id: "cli_a", name: "Cliente A" });
    seedCustomer(env, { id: "cli_b", name: "Cliente B" });
    seedCustomer(env, { id: "cli_c", name: "Cliente C" });
    seedCustomer(env, { id: "cli_d", name: "Cliente D" });
    seedCustomer(env, { id: "cli_e", name: "Cliente E" });

    // A: 1 título, 3 dias de atraso, R$ 500 → bucket 1-7, risco baixo.
    seedReceivable(env, { customerId: "cli_a", dueDate: "2026-08-15", amountCents: 50_000 });
    // Títulos não elegíveis de A: futuro e já recebido.
    seedReceivable(env, { customerId: "cli_a", dueDate: "2026-09-01", amountCents: 999_999 });
    seedReceivable(env, {
      customerId: "cli_a",
      dueDate: "2026-08-01",
      amountCents: 80_000,
      receivedCents: 80_000,
      status: "received",
    });
    // B: 1 título, 10 dias, R$ 2.000 → bucket 8-30, risco médio (>= R$ 1.000).
    seedReceivable(env, { customerId: "cli_b", dueDate: "2026-08-08", amountCents: 200_000 });
    // C: 3 títulos pequenos → risco alto por quantidade; maior atraso 69 dias → bucket 60+.
    seedReceivable(env, { customerId: "cli_c", dueDate: "2026-06-10", amountCents: 10_000 });
    seedReceivable(env, { customerId: "cli_c", dueDate: "2026-07-30", amountCents: 20_000 });
    seedReceivable(env, { customerId: "cli_c", dueDate: "2026-08-16", amountCents: 30_000 });
    // D: 1 título parcialmente recebido, saldo R$ 15.000 (> R$ 10.000) → risco alto; 44 dias → 31-60.
    seedReceivable(env, {
      customerId: "cli_d",
      dueDate: "2026-07-05",
      amountCents: 2_000_000,
      receivedCents: 500_000,
      status: "partially_received",
    });
    // E: 2 títulos pequenos → risco médio (nem 1 título, nem >= 3, nem > R$ 10.000).
    seedReceivable(env, { customerId: "cli_e", dueDate: "2026-08-16", amountCents: 20_000 });
    seedReceivable(env, { customerId: "cli_e", dueDate: "2026-08-14", amountCents: 20_000 });

    const res = await run(env, { action: "segment_customers" });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);

    const data = res.data as SegmentCustomersData;
    expect(data.segments).toHaveLength(5);
    // Ordenação por saldo vencido decrescente.
    expect(data.segments[0].customerId).toBe("cli_d");
    expect(data.totalOverdueCents).toBe(1_850_000);
    expect(data.formula).toContain("dueDate < hoje");
    expect(data.period).toContain(TODAY);

    const byId = new Map(data.segments.map((s) => [s.customerId, s]));
    expect(byId.get("cli_a")).toMatchObject({
      customerName: "Cliente A",
      bucket: "1-7",
      risk: "baixo",
      overdueCount: 1,
      overdueCents: 50_000,
      maxDaysLate: 3,
    });
    expect(byId.get("cli_b")).toMatchObject({
      bucket: "8-30",
      risk: "medio",
      overdueCount: 1,
      overdueCents: 200_000,
      maxDaysLate: 10,
    });
    expect(byId.get("cli_c")).toMatchObject({
      bucket: "60+",
      risk: "alto",
      overdueCount: 3,
      overdueCents: 60_000,
      maxDaysLate: 69,
    });
    expect(byId.get("cli_d")).toMatchObject({
      bucket: "31-60",
      risk: "alto",
      overdueCount: 1,
      overdueCents: 1_500_000,
      maxDaysLate: 44,
    });
    expect(byId.get("cli_e")).toMatchObject({
      bucket: "1-7",
      risk: "medio",
      overdueCount: 2,
      overdueCents: 40_000,
      maxDaysLate: 4,
    });
  });

  it("retorna lista vazia sem títulos vencidos", async () => {
    const env = createTestEnv();
    seedCustomer(env, { id: "cli_1" });
    seedReceivable(env, { customerId: "cli_1", dueDate: "2026-09-10" });

    const res = await run(env, { action: "segment_customers" });
    expect(res.status).toBe("success");
    expect((res.data as SegmentCustomersData).segments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// run_dunning
// ---------------------------------------------------------------------------

function seedDunningScenario(env: TestEnv) {
  seedCustomer(env, { id: "cli_1", name: "Padaria Estrela" });
  seedCustomer(env, { id: "cli_2", name: "Mercado Bom Preço" });
  // 5 dias de atraso → step 3 (maior daysOverdue <= 5).
  seedReceivable(env, { id: "rcv_1", customerId: "cli_1", dueDate: "2026-08-13", amountCents: 100_000 });
  // 44 dias de atraso → step 30.
  seedReceivable(env, { id: "rcv_2", customerId: "cli_2", dueDate: "2026-07-05", amountCents: 200_000 });
  // 1 dia de atraso → nenhum step (mínimo da régua padrão é 3) → não elegível.
  seedReceivable(env, { id: "rcv_3", customerId: "cli_1", dueDate: "2026-08-17", amountCents: 50_000 });
}

// Encargos (política padrão: multa 2%, juros 1% a.m. pró-rata die):
// rcv_1: 100000 + 2000 + round(100000*0.01*5/30)=167  → 102167
// rcv_2: 200000 + 4000 + round(200000*0.01*44/30)=2933 → 206933
const RCV1_TOTAL = 102_167;
const RCV2_TOTAL = 206_933;

describe("cobranca_inadimplencia — run_dunning", () => {
  it("cria rascunhos com template renderizado, escolhe o maior step aplicável e pede aprovação", async () => {
    const env = createTestEnv();
    seedDunningScenario(env);

    const res = await run(env, { action: "run_dunning" });
    expect(res.status).toBe("awaiting_approval");
    expect(res.requires_human_approval).toBe(true);

    const data = res.data as RunDunningData;
    expect(data.messages).toHaveLength(2);
    expect(data.sent).toBe(0);

    const msg1 = data.messages.find((m) => m.receivableId === "rcv_1")!;
    expect(msg1).toBeDefined();
    expect(msg1.step).toBe(3);
    expect(msg1.channel).toBe("email");
    expect(msg1.status).toBe("awaiting_approval");
    expect(msg1.subject).toBe("Lembrete de vencimento — PME Teste Ltda");
    expect(msg1.body).toContain("Padaria Estrela");
    expect(msg1.body).toContain(formatBRL(RCV1_TOTAL));
    expect(msg1.body).toContain("13/08/2026");
    expect(msg1.body).toContain("há 5 dias");
    expect(msg1.subject).not.toContain("{{");
    expect(msg1.body).not.toContain("{{");

    const msg2 = data.messages.find((m) => m.receivableId === "rcv_2")!;
    expect(msg2).toBeDefined();
    expect(msg2.step).toBe(30);
    expect(msg2.subject).toBe("Regularização de pendência — PME Teste Ltda");
    expect(msg2.body).toContain("Mercado Bom Preço");
    expect(msg2.body).toContain(formatBRL(RCV2_TOTAL));
    expect(msg2.body).toContain("05/07/2026");
    expect(msg2.body).not.toContain("{{");

    // rcv_3 (1 dia de atraso) não alcança o primeiro degrau da régua.
    expect(data.messages.some((m) => m.receivableId === "rcv_3")).toBe(false);

    expect(data.approvalRequest).toMatchObject({
      targetType: "collection_message",
      targetId: "corr_test",
      amountCents: RCV1_TOTAL + RCV2_TOTAL,
    });
    expect(data.approvalRequest!.summary).toContain("2 mensagem");
    expect(data.approvalRequest!.summary).toContain(formatBRL(RCV1_TOTAL + RCV2_TOTAL));

    const drafted = await env.repos.events.list(env.company.id, "collection.message_drafted");
    expect(drafted).toHaveLength(2);
    const persisted = await env.repos.collectionMessages.listAll(env.company.id);
    expect(persisted).toHaveLength(2);
    expect(persisted.every((m) => m.status === "awaiting_approval")).toBe(true);
  });

  it("é idempotente: rodar 2x sem aprovar não duplica mensagens do mesmo step", async () => {
    const env = createTestEnv();
    seedDunningScenario(env);

    await run(env, { action: "run_dunning" });
    const second = await run(env, { action: "run_dunning" });

    expect(second.status).toBe("success");
    const data = second.data as RunDunningData;
    expect(data.messages).toEqual([]);
    expect(data.sent).toBe(0);
    expect(second.assumptions.join(" ")).toContain("idempotência");
    // Pendências apontam para as mensagens que seguem aguardando aprovação.
    expect(second.pending_items).toHaveLength(2);

    const persisted = await env.repos.collectionMessages.listAll(env.company.id);
    expect(persisted).toHaveLength(2);
    const drafted = await env.repos.events.list(env.company.id, "collection.message_drafted");
    expect(drafted).toHaveLength(2);
  });

  it("com aprovação marca as mensagens como enviadas (mock) e publica eventos", async () => {
    const env = createTestEnv();
    seedDunningScenario(env);
    await run(env, { action: "run_dunning" });

    const { res, data, approvalId } = await decideDunning(env, "approved");
    expect(res.status).toBe("success");
    expect(data.sent).toBe(2);
    expect(data.messages).toHaveLength(2);
    expect(res.assumptions.join(" ").toLowerCase()).toContain("mock");

    const persisted = await env.repos.collectionMessages.listAll(env.company.id);
    expect(persisted).toHaveLength(2);
    for (const m of persisted) {
      expect(m.status).toBe("sent");
      expect(m.sentAt).toBe("2026-08-18T15:00:00.000Z");
      expect(m.approvalId).toBe(approvalId);
    }
    const sentEvents = await env.repos.events.list(env.company.id, "collection.message_sent");
    expect(sentEvents).toHaveLength(2);

    // Auditoria de envio registrada por mensagem.
    const audit = await env.repos.audit.list(env.company.id, { entityType: "collection_message" });
    expect(audit.filter((a) => a.action === "collection.message_sent")).toHaveLength(2);

    // Retomada repetida com a mesma decisão é idempotente (sem novo efeito).
    const replay = await decideDunning(env, "approved", { approvalId });
    expect(replay.res.status).toBe("success");
    expect(replay.data.sent).toBe(2);
    expect(replay.res.assumptions.join(" ")).toContain("idempotente");
    expect(await env.repos.events.list(env.company.id, "collection.message_sent")).toHaveLength(2);
  });

  it("com rejeição cancela as mensagens pendentes e nada é enviado", async () => {
    const env = createTestEnv();
    seedDunningScenario(env);
    await run(env, { action: "run_dunning" });

    const { res, data } = await decideDunning(env, "rejected", {
      justification: "texto precisa de revisão",
    });
    expect(res.status).toBe("success");
    expect(data.sent).toBe(0);
    expect(data.messages).toHaveLength(2);
    expect(res.assumptions.join(" ")).toContain("texto precisa de revisão");

    const persisted = await env.repos.collectionMessages.listAll(env.company.id);
    expect(persisted.every((m) => m.status === "canceled")).toBe(true);
    expect(await env.repos.events.list(env.company.id, "collection.message_sent")).toHaveLength(0);

    // Mensagens canceladas NÃO bloqueiam nova execução da régua para o mesmo step.
    const rerun = await run(env, { action: "run_dunning" });
    expect(rerun.status).toBe("awaiting_approval");
    expect((rerun.data as RunDunningData).messages).toHaveLength(2);
  });

  it("sem títulos elegíveis retorna sucesso com lista vazia e suposição explícita", async () => {
    const env = createTestEnv();
    seedCustomer(env, { id: "cli_1" });
    seedReceivable(env, { customerId: "cli_1", dueDate: "2026-09-10" }); // não vencido

    const res = await run(env, { action: "run_dunning" });
    expect(res.status).toBe("success");
    expect(res.requires_human_approval).toBe(false);
    const data = res.data as RunDunningData;
    expect(data.messages).toEqual([]);
    expect(data.sent).toBe(0);
    expect(data.approvalRequest).toBeUndefined();
    expect(res.assumptions.join(" ").toLowerCase()).toContain("nenhum título elegível");
  });
});

// ---------------------------------------------------------------------------
// suggest_renegotiation
// ---------------------------------------------------------------------------

describe("cobranca_inadimplencia — suggest_renegotiation", () => {
  it("calcula as três opções com valores exatos e não altera o título", async () => {
    const env = createTestEnv();
    seedCustomer(env, { id: "cli_1", name: "Padaria Estrela" });
    // Saldo devedor = 150.000 - 50.000 = 100.000; 30 dias de atraso.
    seedReceivable(env, {
      id: "rcv_ren",
      customerId: "cli_1",
      dueDate: "2026-07-19",
      amountCents: 150_000,
      receivedCents: 50_000,
      status: "partially_received",
    });

    const res = await run(env, { action: "suggest_renegotiation", receivableId: "rcv_ren" });
    expect(res.status).toBe("success");
    expect(res.requires_human_approval).toBe(true);
    expect(res.confidence).toBe(1.0);

    const data = res.data as SuggestRenegotiationData;
    // Encargos: multa 2% = 2.000; juros 1% a.m. × 30/30 dias = 1.000; total 103.000.
    expect(data.principalCents).toBe(100_000);
    expect(data.daysLate).toBe(30);
    expect(data.fineCents).toBe(2_000);
    expect(data.interestCents).toBe(1_000);
    expect(data.totalWithChargesCents).toBe(103_000);
    expect(data.chargesFormula).toContain("principal");
    expect(data.period).toContain(TODAY);
    expect(data.options).toHaveLength(3);

    const [cash, two, three] = data.options;
    // À vista: desconta só os juros, mantém a multa → 102.000.
    expect(cash.code).toBe("avista_desconto_juros");
    expect(cash.totalCents).toBe(102_000);
    expect(cash.installments).toEqual([{ number: 1, dueDate: TODAY, amountCents: 102_000 }]);
    expect(cash.formula).toContain("juros");

    // 2x sem juros adicionais sobre o total com encargos.
    expect(two.code).toBe("parcelado_2x_sem_juros");
    expect(two.totalCents).toBe(103_000);
    expect(two.installments).toEqual([
      { number: 1, dueDate: "2026-08-18", amountCents: 51_500 },
      { number: 2, dueDate: "2026-09-18", amountCents: 51_500 },
    ]);

    // 3x com juros da política: 103.000 × 3% = 3.090 → total 106.090.
    expect(three.code).toBe("parcelado_3x_juros_politica");
    expect(three.totalCents).toBe(106_090);
    expect(three.installments).toEqual([
      { number: 1, dueDate: "2026-08-18", amountCents: 35_364 },
      { number: 2, dueDate: "2026-09-18", amountCents: 35_363 },
      { number: 3, dueDate: "2026-10-18", amountCents: 35_363 },
    ]);
    expect(three.installments.reduce((acc, p) => acc + p.amountCents, 0)).toBe(106_090);

    // Recomendação apenas: o título permanece intacto.
    const receivable = await env.repos.receivables.getById(env.company.id, "rcv_ren");
    expect(receivable).toMatchObject({
      status: "partially_received",
      amountCents: 150_000,
      receivedCents: 50_000,
    });
    expect(res.assumptions.join(" ")).toContain("aprovação humana");
  });

  it("falha para título inexistente ou não vencido", async () => {
    const env = createTestEnv();
    seedCustomer(env, { id: "cli_1" });
    seedReceivable(env, { id: "rcv_futuro", customerId: "cli_1", dueDate: "2026-09-01" });

    const notFound = await run(env, {
      action: "suggest_renegotiation",
      receivableId: "rcv_inexistente",
    });
    expect(notFound.status).toBe("error");
    expect(notFound.alerts[0].code).toBe("not_found");

    const notOverdue = await run(env, {
      action: "suggest_renegotiation",
      receivableId: "rcv_futuro",
    });
    expect(notOverdue.status).toBe("error");
    expect(notOverdue.alerts[0].code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// delinquency_indicators
// ---------------------------------------------------------------------------

describe("cobranca_inadimplencia — delinquency_indicators", () => {
  it("calcula os indicadores com valores exatos e persiste alerta de inadimplência alta (com dedupe)", async () => {
    const env = createTestEnv();
    seedCustomer(env, { id: "cli_1" });
    seedCustomer(env, { id: "cli_2" });
    // Vencidos: 60.000 (3 dias, bucket 1-7) + 40.000 (40 dias, bucket 31-60) = 100.000.
    seedReceivable(env, { customerId: "cli_1", dueDate: "2026-08-15", amountCents: 60_000 });
    seedReceivable(env, { customerId: "cli_2", dueDate: "2026-07-09", amountCents: 40_000 });
    // Em aberto não vencido: 100.000 → carteira ativa total 200.000.
    seedReceivable(env, { customerId: "cli_1", dueDate: "2026-09-01", amountCents: 100_000 });
    // Recebido (fora da carteira ativa).
    seedReceivable(env, {
      customerId: "cli_2",
      dueDate: "2026-08-01",
      amountCents: 70_000,
      receivedCents: 70_000,
      status: "received",
    });
    // Recebimentos dos últimos 90 dias: 50.000.
    seedReceipt(env, { amountCents: 50_000, receivedDate: "2026-07-01" });

    const res = await run(env, { action: "delinquency_indicators" });
    expect(res.status).toBe("warning"); // inadimplência 50% > 10% gera alerta
    expect(res.confidence).toBe(0.9); // DSO é aproximação

    const { indicators } = res.data as DelinquencyIndicatorsData;
    // 100.000 / 200.000 = 50%
    expect(indicators.delinquencyRatePercent.value).toBe(50);
    expect(indicators.agingCents.value).toEqual({
      "1-7": 60_000,
      "8-30": 0,
      "31-60": 40_000,
      "60+": 0,
    });
    // 100.000 / 2 títulos vencidos
    expect(indicators.averageOverdueTicketCents.value).toBe(50_000);
    expect(indicators.delinquentCustomerCount.value).toBe(2);
    // DSO = (200.000 / 50.000) × 90 = 360 dias.
    expect(indicators.dsoDays.value).toBe(360);
    expect(indicators.dsoDays.period).toContain("2026-05-20");
    expect(indicators.dsoDays.sources).toContain("receipts");

    for (const indicator of Object.values(indicators)) {
      expect(indicator.formula.length).toBeGreaterThan(0);
      expect(indicator.period.length).toBeGreaterThan(0);
      expect(indicator.sources.length).toBeGreaterThan(0);
    }

    expect(res.alerts.some((a) => a.code === "high_delinquency")).toBe(true);
    const open = await env.repos.alerts.listOpen(env.company.id);
    expect(open.filter((a) => a.code === "high_delinquency")).toHaveLength(1);

    // Dedupe: reexecutar não duplica o alerta persistido.
    await run(env, { action: "delinquency_indicators" });
    const openAfter = await env.repos.alerts.listOpen(env.company.id);
    expect(openAfter.filter((a) => a.code === "high_delinquency")).toHaveLength(1);
  });

  it("sem carteira e sem recebimentos informa null com suposições e não alerta", async () => {
    const env = createTestEnv();

    const res = await run(env, { action: "delinquency_indicators" });
    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);

    const { indicators } = res.data as DelinquencyIndicatorsData;
    expect(indicators.delinquencyRatePercent.value).toBeNull();
    expect(indicators.agingCents.value).toEqual({ "1-7": 0, "8-30": 0, "31-60": 0, "60+": 0 });
    expect(indicators.averageOverdueTicketCents.value).toBeNull();
    expect(indicators.delinquentCustomerCount.value).toBe(0);
    expect(indicators.dsoDays.value).toBeNull();
    expect(res.assumptions.join(" ")).toContain("DSO não calculado");
    expect(res.alerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------

describe("cobranca_inadimplencia — validação de entrada", () => {
  it("rejeita ação desconhecida e entrada malformada", async () => {
    const env = createTestEnv();

    const unknown = await run(env, { action: "enviar_tudo_agora" });
    expect(unknown.status).toBe("error");
    expect(unknown.alerts[0].code).toBe("invalid_input");

    const missing = await run(env, { action: "suggest_renegotiation" });
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("invalid_input");
  });
});
