import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type {
  BankAccount,
  Category,
  Payable,
  RecurringTemplate,
  Supplier,
} from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  contasAPagarSkill,
  type CancelPayableData,
  type CreatePayableData,
  type DetectDuplicatesData,
  type ForecastDisbursementsData,
  type GenerateRecurringData,
  type ListDueData,
  type SchedulePaymentData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.
const TODAY = "2026-08-18";

let seedSeq = 0;

function seedSupplier(env: TestEnv, over: Partial<Supplier> = {}): Supplier {
  const now = env.clock.now().toISOString();
  const supplier: Supplier = {
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Alfa Ltda",
    document: "11.222.333/0001-44",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.suppliers.push(supplier);
  return supplier;
}

function seedBankAccount(env: TestEnv, over: Partial<BankAccount> = {}): BankAccount {
  const now = env.clock.now().toISOString();
  const account: BankAccount = {
    id: "ba_1",
    companyId: env.company.id,
    name: "Conta Corrente Principal",
    bankCode: "341",
    agency: "0001",
    accountNumberMasked: "***1234",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 10_000_000,
    openingBalanceDate: "2026-01-01",
    active: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.bankAccounts.push(account);
  return account;
}

function seedCategory(env: TestEnv, over: Partial<Category> = {}): Category {
  const category: Category = {
    id: "cat_alu",
    companyId: env.company.id,
    name: "Aluguel e Condomínio",
    kind: "expense",
    dreGroup: "despesas_operacionais",
    active: true,
    ...over,
  };
  env.db.categories.push(category);
  return category;
}

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_seed_${++seedSeq}`;
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Título semeado",
    issueDate: "2026-08-01",
    dueDate: "2026-08-20",
    amountCents: 50_000,
    paidCents: 0,
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
  env.db.payables.push(payable);
  return payable;
}

function baseCreateInput(over: Record<string, unknown> = {}) {
  return {
    action: "create_payable",
    supplierId: "sup_1",
    description: "Serviço de manutenção",
    issueDate: "2026-08-10",
    dueDate: "2026-09-10",
    amountCents: 100_000,
    ...over,
  };
}

async function schedule(env: TestEnv, payableId: string, amountCents?: number) {
  const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("analyst")), {
    action: "schedule_payment",
    payableId,
    bankAccountId: "ba_1",
    scheduledDate: "2026-08-19",
    method: "pix",
    ...(amountCents !== undefined ? { amountCents } : {}),
  });
  return { res, data: res.data as SchedulePaymentData };
}

/** Simula a retomada pós-decisão: grava a Approval no repositório e reexecuta com ctx.approval. */
async function decide(
  env: TestEnv,
  paymentId: string,
  status: "approved" | "rejected",
  decidedBy = "usr_approver"
) {
  const now = env.clock.now().toISOString();
  const approvalId = env.ids.next("apr");
  await env.repos.approvals.create({
    id: approvalId,
    companyId: env.company.id,
    targetType: "payment",
    targetId: paymentId,
    summary: "Aprovação de pagamento (teste)",
    amountCents: undefined,
    requestedBy: "usr_analyst",
    requiredRole: "approver",
    status,
    decidedBy,
    decidedAt: now,
    createdAt: now,
  });
  const ctx = {
    ...env.ctx(env.actorFor("analyst")),
    approval: { id: approvalId, status, decidedBy },
  };
  const res = await runSkill(contasAPagarSkill, ctx, {
    action: "schedule_payment",
    payableId: "ignorado-na-retomada",
    bankAccountId: "ba_1",
    scheduledDate: "2026-08-19",
    method: "pix",
  });
  return { res, data: res.data as SchedulePaymentData };
}

describe("contas_a_pagar — create_payable", () => {
  it("cria título parcelado com soma exata e vencimentos mensais", async () => {
    const env = createTestEnv();
    seedSupplier(env);

    const res = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({
        amountCents: 100_001,
        installmentCount: 3,
        categoryId: seedCategory(env).id,
        document: {
          type: "nfe",
          number: "NF-123",
          issuedAt: "2026-08-10",
          totalCents: 100_001,
        },
      })
    );

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    const data = res.data as CreatePayableData;
    expect(data.payables).toHaveLength(3);
    // splitInstallments(100001, 3) = [33334, 33334, 33333] — resto nas primeiras parcelas.
    expect(data.payables.map((p) => p.amountCents)).toEqual([33_334, 33_334, 33_333]);
    expect(data.payables.reduce((acc, p) => acc + p.amountCents, 0)).toBe(100_001);
    expect(data.payables.map((p) => p.dueDate)).toEqual(["2026-09-10", "2026-10-10", "2026-11-10"]);
    expect(data.payables.map((p) => p.originKey)).toEqual([
      "sup_1:NF-123:1/3",
      "sup_1:NF-123:2/3",
      "sup_1:NF-123:3/3",
    ]);
    expect(data.document?.contentHash).toBeTruthy();
    expect(env.db.documents).toHaveLength(1);
    expect(env.db.events.filter((e) => e.type === "payable.created")).toHaveLength(3);
    expect(env.db.auditRecords.filter((a) => a.action === "payable.created")).toHaveLength(3);
  });

  it("rejeita número de parcelas acima de 120 (simetria com contas a receber)", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedCategory(env);

    const res = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ installmentCount: 121, categoryId: "cat_alu" })
    );

    expect(res.status).toBe("error");
    expect(res.alerts?.[0]?.code).toBe("invalid_input");
    expect(env.db.payables).toHaveLength(0);
  });

  it("é idempotente: mesma entrada 2x não duplica títulos nem eventos", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedCategory(env);
    const input = baseCreateInput({ categoryId: "cat_alu" });

    const first = await runSkill(contasAPagarSkill, env.ctx(), input);
    const second = await runSkill(contasAPagarSkill, env.ctx(), input);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(env.db.payables).toHaveLength(1);
    expect(env.db.events.filter((e) => e.type === "payable.created")).toHaveLength(1);
    const firstData = first.data as CreatePayableData;
    const secondData = second.data as CreatePayableData;
    expect(secondData.payables[0].id).toBe(firstData.payables[0].id);
    expect(second.assumptions.some((a) => a.includes("reutilizado"))).toBe(true);
  });

  it("cria obrigações recorrentes distintas quando muda o vencimento (mesmo nome/valor)", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedCategory(env, { id: "cat_alu" });

    // Aluguel de agosto (sem documento): descrição e valor iguais aos de setembro,
    // mudando apenas emissão/vencimento — devem ser títulos SEPARADOS.
    const agosto = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({
        description: "Aluguel",
        amountCents: 200_000,
        issueDate: "2026-08-01",
        dueDate: "2026-08-10",
        categoryId: "cat_alu",
      })
    );
    const setembro = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({
        description: "Aluguel",
        amountCents: 200_000,
        issueDate: "2026-09-01",
        dueDate: "2026-09-10",
        categoryId: "cat_alu",
      })
    );

    expect(agosto.status).toBe("success");
    expect(setembro.status).toBe("success");
    const idAgosto = (agosto.data as CreatePayableData).payables[0].id;
    const idSetembro = (setembro.data as CreatePayableData).payables[0].id;
    expect(idSetembro).not.toBe(idAgosto);
    expect(env.db.payables).toHaveLength(2);
    expect(setembro.assumptions.some((a) => a.includes("reutilizado"))).toBe(false);
  });

  it("detecta documento duplicado por hash e reutiliza o registro", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedSupplier(env, { id: "sup_2", name: "Fornecedora Beta ME" });
    seedCategory(env);
    const document = { type: "nfe" as const, number: "NF-777", issuedAt: "2026-08-10", totalCents: 100_000 };

    const first = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ categoryId: "cat_alu", document })
    );
    const second = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ supplierId: "sup_2", categoryId: "cat_alu", document })
    );

    expect(first.status).toBe("success");
    expect(second.status).toBe("warning");
    expect(second.alerts.some((a) => a.code === "duplicate_document")).toBe(true);
    expect(env.db.documents).toHaveLength(1);
    const firstData = first.data as CreatePayableData;
    const secondData = second.data as CreatePayableData;
    expect(secondData.document?.id).toBe(firstData.document?.id);
    // O título do segundo fornecedor é criado normalmente, apontando para o mesmo documento.
    expect(env.db.payables).toHaveLength(2);
    expect(env.db.alerts.some((a) => a.code === "duplicate_document")).toBe(true);
  });

  it("classifica via IA quando não há categoria e rebaixa a confiança", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const category = seedCategory(env);

    const res = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ description: "Aluguel do galpão — agosto" })
    );

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(0.7); // confiança da sugestão heurística (mock)
    const data = res.data as CreatePayableData;
    expect(data.payables[0].categoryId).toBe(category.id);
    expect(res.assumptions.some((a) => a.includes("sugestão automática"))).toBe(true);
  });

  it("sem categoria e sem sugestão: cria com pending_item sem_categoria", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedCategory(env);

    const res = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ description: "Despesa avulsa XYZ" })
    );

    expect(res.status).toBe("success");
    expect(res.confidence).toBe(1.0);
    const data = res.data as CreatePayableData;
    expect(data.payables[0].categoryId).toBeUndefined();
    expect(res.pending_items.some((p) => p.code === "sem_categoria")).toBe(true);
  });

  it("persiste categoria de fornecedor e classificação de custo no título", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedCategory(env);

    const res = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({
        installmentCount: 2,
        supplierCategory: "Material de Escritório",
        costClassification: "fixed",
      })
    );

    expect(res.status).toBe("success");
    const data = res.data as CreatePayableData;
    expect(data.payables).toHaveLength(2);
    for (const p of data.payables) {
      expect(p.supplierCategory).toBe("Material de Escritório");
      expect(p.costClassification).toBe("fixed");
    }
  });

  it("valida fornecedor inexistente e vencimento anterior à emissão", async () => {
    const env = createTestEnv();
    seedSupplier(env);

    const missing = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ supplierId: "sup_nao_existe" })
    );
    expect(missing.status).toBe("error");
    expect(missing.alerts[0].code).toBe("not_found");

    const badDates = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ issueDate: "2026-09-10", dueDate: "2026-08-10" })
    );
    expect(badDates.status).toBe("error");
    expect(badDates.alerts[0].code).toBe("validation_error");
  });
});

describe("contas_a_pagar — schedule_payment e aprovação", () => {
  it("sem aprovação: cria pagamento pendente e retorna awaiting_approval", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });

    const { res, data } = await schedule(env, payable.id);

    expect(res.status).toBe("awaiting_approval");
    expect(res.requires_human_approval).toBe(true);
    expect(data.payment.status).toBe("pending_approval");
    expect(data.payment.amountCents).toBe(50_000); // default = saldo restante
    expect(data.payment.requestedBy).toBe("usr_analyst");
    expect(data.approvalRequest).toMatchObject({
      targetType: "payment",
      targetId: data.payment.id,
      amountCents: 50_000,
    });
    expect(data.approvalRequest?.summary).toContain("Fornecedora Alfa Ltda");
    expect(env.db.payables.find((p) => p.id === payable.id)?.status).toBe("scheduled");
    expect(env.db.events.some((e) => e.type === "payment.scheduled")).toBe(true);
    expect(env.db.events.some((e) => e.type === "payment.executed")).toBe(false);
  });

  it("recusa segundo agendamento que ultrapassa o saldo já reservado por pagamento pendente", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });

    // 1º agendamento reserva o valor integral (fica pending_approval).
    const first = await schedule(env, payable.id);
    expect(first.res.status).toBe("awaiting_approval");

    // 2º agendamento do valor integral deve ser recusado: o saldo já está
    // comprometido por um pagamento pendente (evita dupla baixa).
    const second = await schedule(env, payable.id);
    expect(second.res.status).toBe("error");
    expect(second.res.alerts.some((a) => /saldo|reservad|pendente/i.test(a.message))).toBe(true);

    // Só existe UM pagamento pendente para o título.
    const pendentes = env.db.payments.filter(
      (p) => p.payableId === payable.id && p.status === "pending_approval"
    );
    expect(pendentes).toHaveLength(1);
  });

  it("permite dois agendamentos parciais que somados cabem no saldo", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });

    const first = await schedule(env, payable.id, 20_000);
    expect(first.res.status).toBe("awaiting_approval");
    const second = await schedule(env, payable.id, 30_000);
    expect(second.res.status).toBe("awaiting_approval");

    // Um terceiro de qualquer valor não cabe (saldo todo reservado).
    const third = await schedule(env, payable.id, 1_000);
    expect(third.res.status).toBe("error");
  });

  it("aprovação executa (mock), quita o título e publica payment.executed", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });
    const { data: scheduled } = await schedule(env, payable.id);

    const { res, data } = await decide(env, scheduled.payment.id, "approved");

    expect(res.status).toBe("success");
    expect(data.payment.status).toBe("executed");
    expect(data.payment.executedBy).toBe("usr_approver");
    expect(data.payment.executedAt).toBe(env.clock.now().toISOString());
    const stored = env.db.payables.find((p) => p.id === payable.id);
    expect(stored?.paidCents).toBe(50_000);
    expect(stored?.status).toBe("paid");
    expect(env.db.events.some((e) => e.type === "payment.executed")).toBe(true);
    expect(res.assumptions.some((a) => a.toLowerCase().includes("mock"))).toBe(true);
  });

  it("pagamento parcial aprovado deixa o título partially_paid", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });
    const { data: scheduled } = await schedule(env, payable.id, 20_000);

    const { data } = await decide(env, scheduled.payment.id, "approved");

    expect(data.payment.amountCents).toBe(20_000);
    const stored = env.db.payables.find((p) => p.id === payable.id);
    expect(stored?.paidCents).toBe(20_000);
    expect(stored?.status).toBe("partially_paid");
  });

  it("rejeição cancela o pagamento e devolve o título para open", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });
    const { data: scheduled } = await schedule(env, payable.id);

    const { res, data } = await decide(env, scheduled.payment.id, "rejected");

    expect(res.status).toBe("success");
    expect(data.payment.status).toBe("rejected");
    const stored = env.db.payables.find((p) => p.id === payable.id);
    expect(stored?.status).toBe("open");
    expect(stored?.paidCents).toBe(0);
    expect(env.db.events.some((e) => e.type === "payment.executed")).toBe(false);
  });

  it("valida valor acima do saldo restante e conta bancária inexistente", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000, paidCents: 30_000, status: "partially_paid" });

    const tooMuch = await schedule(env, payable.id, 30_001);
    expect(tooMuch.res.status).toBe("error");
    expect(tooMuch.res.alerts[0].code).toBe("validation_error");

    const badAccount = await runSkill(contasAPagarSkill, env.ctx(), {
      action: "schedule_payment",
      payableId: payable.id,
      bankAccountId: "ba_nao_existe",
      scheduledDate: "2026-08-19",
      method: "pix",
    });
    expect(badAccount.status).toBe("error");
    expect(badAccount.alerts[0].code).toBe("not_found");
  });
});

describe("contas_a_pagar — list_due", () => {
  it("calcula juros e multa exatos para vencidos e alerta vencimentos próximos", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const overdue = seedPayable(env, { dueDate: "2026-08-08", amountCents: 100_000 }); // 10 dias de atraso
    const dueSoon = seedPayable(env, { dueDate: "2026-08-20", amountCents: 50_000 }); // vence em 2 dias
    seedPayable(env, { dueDate: "2026-09-10", amountCents: 999_999 }); // fora da janela de 7 dias

    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "list_due" });

    expect(res.confidence).toBe(1.0);
    const data = res.data as ListDueData;
    expect(data.due).toHaveLength(2);
    expect(data.period).toEqual({ start: TODAY, end: "2026-08-25" });

    // Vencido: multa 2% de 100.000 = 2.000; juros 100.000 × (1%/30) × 10 = 333 (half-up).
    const late = data.due.find((d) => d.payableId === overdue.id)!;
    expect(late.daysLate).toBe(10);
    expect(late.fineCents).toBe(2_000);
    expect(late.interestCents).toBe(333);
    expect(late.totalDueCents).toBe(102_333);
    expect(late.formula).toContain("principal");

    const soon = data.due.find((d) => d.payableId === dueSoon.id)!;
    expect(soon.daysLate).toBe(0);
    expect(soon.fineCents).toBe(0);
    expect(soon.interestCents).toBe(0);
    expect(soon.totalDueCents).toBe(50_000);

    expect(data.totalDueCents).toBe(152_333);
    expect(res.alerts.some((a) => a.code === "payable_overdue" && a.entityId === overdue.id)).toBe(true);
    expect(res.alerts.some((a) => a.code === "payable_due_soon" && a.entityId === dueSoon.id)).toBe(true);
  });

  it("persiste alertas com dedupe por code+entityId em reexecuções", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedPayable(env, { dueDate: "2026-08-08", amountCents: 100_000 });
    seedPayable(env, { dueDate: "2026-08-20", amountCents: 50_000 });

    await runSkill(contasAPagarSkill, env.ctx(), { action: "list_due" });
    await runSkill(contasAPagarSkill, env.ctx(), { action: "list_due" });

    expect(env.db.alerts.filter((a) => a.code === "payable_overdue")).toHaveLength(1);
    expect(env.db.alerts.filter((a) => a.code === "payable_due_soon")).toHaveLength(1);
    expect(env.db.alerts.every((a) => a.source === "contas_a_pagar")).toBe(true);
  });
});

describe("contas_a_pagar — forecast_disbursements", () => {
  it("agrupa saldos por semana a partir de hoje, com vencidos na semana atual", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedPayable(env, { dueDate: "2026-08-08", amountCents: 100_000 }); // vencido → semana 1
    seedPayable(env, { dueDate: "2026-08-20", amountCents: 50_000 }); // semana 1
    seedPayable(env, { dueDate: "2026-08-27", amountCents: 30_000, paidCents: 10_000, status: "partially_paid" }); // semana 2, saldo 20.000
    seedPayable(env, { dueDate: "2026-10-01", amountCents: 999_999 }); // fora do horizonte

    const res = await runSkill(contasAPagarSkill, env.ctx(), {
      action: "forecast_disbursements",
      horizonDays: 14,
    });

    expect(res.confidence).toBeLessThan(1.0);
    const data = res.data as ForecastDisbursementsData;
    expect(data.horizonDays).toBe(14);
    expect(data.weekly).toHaveLength(2);
    expect(data.weekly[0]).toEqual({
      weekStart: "2026-08-18",
      weekEnd: "2026-08-24",
      totalCents: 150_000,
      count: 2,
    });
    expect(data.weekly[1]).toEqual({
      weekStart: "2026-08-25",
      weekEnd: "2026-08-31",
      totalCents: 20_000,
      count: 1,
    });
    expect(data.totalCents).toBe(170_000);
    expect(data.formula).toContain("saldo restante");
    expect(res.assumptions.some((a) => a.includes("vencido"))).toBe(true);
  });
});

describe("contas_a_pagar — detect_duplicates", () => {
  it("aponta pares com mesmo fornecedor+valor+vencimento e persiste alerta único", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const a = seedPayable(env, { dueDate: "2026-08-25", amountCents: 75_000 });
    const b = seedPayable(env, { dueDate: "2026-08-25", amountCents: 75_000 });
    seedPayable(env, { dueDate: "2026-08-25", amountCents: 12_345 }); // valor distinto: não é suspeito
    seedPayable(env, { dueDate: "2026-08-25", amountCents: 75_000, status: "canceled" }); // cancelado: ignorado

    const first = await runSkill(contasAPagarSkill, env.ctx(), { action: "detect_duplicates" });
    const second = await runSkill(contasAPagarSkill, env.ctx(), { action: "detect_duplicates" });

    expect(first.confidence).toBeLessThan(1.0);
    const data = first.data as DetectDuplicatesData;
    expect(data.suspects).toHaveLength(1);
    expect(data.suspects[0].payableIds.sort()).toEqual([a.id, b.id].sort());
    expect(data.suspects[0].reason).toContain("chaves de origem distintas");
    expect((second.data as DetectDuplicatesData).suspects).toHaveLength(1);
    // Reexecução não duplica o alerta persistido.
    expect(env.db.alerts.filter((al) => al.code === "possible_duplicate_payable")).toHaveLength(1);
  });

  it("aponta títulos distintos vinculados ao mesmo documento e parcela", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedPayable(env, { documentId: "doc_1", amountCents: 10_000, dueDate: "2026-08-25" });
    seedPayable(env, { documentId: "doc_1", amountCents: 22_000, dueDate: "2026-09-25" });

    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "detect_duplicates" });

    const data = res.data as DetectDuplicatesData;
    expect(data.suspects).toHaveLength(1);
    expect(data.suspects[0].reason).toContain("documento fiscal");
  });
});

describe("contas_a_pagar — cancel_payable", () => {
  it("cancela título aberto, cancela pagamento pendente vinculado e publica evento", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });
    const { data: scheduled } = await schedule(env, payable.id);

    const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("manager")), {
      action: "cancel_payable",
      payableId: payable.id,
      reason: "Compra cancelada junto ao fornecedor",
    });

    expect(res.status).toBe("success");
    const data = res.data as CancelPayableData;
    expect(data.payable.status).toBe("canceled");
    expect(data.payable.canceledAt).toBe(env.clock.now().toISOString());
    expect(env.db.payments.find((p) => p.id === scheduled.payment.id)?.status).toBe("canceled");
    expect(env.db.events.some((e) => e.type === "payable.canceled")).toBe(true);
    const audit = env.db.auditRecords.find((a) => a.action === "payable.canceled");
    expect(audit?.before).toBeTruthy();
    expect(audit?.after).toBeTruthy();
  });

  it("bloqueia cancelamento após pagamento executado", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedBankAccount(env);
    const payable = seedPayable(env, { amountCents: 50_000 });
    const { data: scheduled } = await schedule(env, payable.id, 20_000);
    await decide(env, scheduled.payment.id, "approved");

    const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("manager")), {
      action: "cancel_payable",
      payableId: payable.id,
      reason: "Tentativa inválida",
    });

    expect(res.status).toBe("error");
    expect(res.alerts[0].code).toBe("validation_error");
    expect(env.db.payables.find((p) => p.id === payable.id)?.status).toBe("partially_paid");
  });

  it("bloqueia ator sem permissão payable.cancel (viewer/analista)", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env);

    for (const key of ["viewer", "analyst"] as const) {
      const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor(key)), {
        action: "cancel_payable",
        payableId: payable.id,
        reason: "sem permissão",
      });
      expect(res.status).toBe("error");
      expect(res.alerts[0].code).toBe("permission_denied");
    }
    expect(env.db.payables.find((p) => p.id === payable.id)?.status).toBe("open");
  });
});

describe("contas_a_pagar — validação de entrada", () => {
  it("rejeita ação desconhecida e valores não inteiros", async () => {
    const env = createTestEnv();
    seedSupplier(env);

    const unknown = await runSkill(contasAPagarSkill, env.ctx(), { action: "explodir_tudo" });
    expect(unknown.status).toBe("error");
    expect(unknown.alerts[0].code).toBe("invalid_input");

    const float = await runSkill(
      contasAPagarSkill,
      env.ctx(),
      baseCreateInput({ amountCents: 100.5 })
    );
    expect(float.status).toBe("error");
    expect(float.alerts[0].code).toBe("invalid_input");
  });
});

function seedTemplate(env: TestEnv, over: Partial<RecurringTemplate> = {}): RecurringTemplate {
  const now = env.clock.now().toISOString();
  const t: RecurringTemplate = {
    id: `rec_${(seedSeq += 1)}`,
    companyId: env.company.id,
    kind: "payable",
    counterpartyId: "sup_1",
    description: "Aluguel",
    amountCents: 200_000,
    dueDay: 5,
    startDate: "2026-01-01",
    status: "active",
    createdBy: env.actorFor("admin").id,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.recurringTemplates.push(t);
  return t;
}

describe("contas_a_pagar — generate_recurring", () => {
  it("gera o título do mês corrente para um template ativo, com o vencimento no dueDay", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedTemplate(env, { dueDay: 5, amountCents: 200_000, category: "Aluguéis" });

    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "generate_recurring" });

    expect(res.status).toBe("success");
    const data = res.data as GenerateRecurringData;
    expect(data.generated).toHaveLength(1);
    // TODAY = 2026-08-18 → mês 2026-08 → vencimento 2026-08-05
    const p = env.db.payables.find((x) => x.id === data.generated[0].payableId);
    expect(p?.dueDate).toBe("2026-08-05");
    expect(p?.amountCents).toBe(200_000);
    expect(p?.supplierCategory).toBe("Aluguéis");
  });

  it("é idempotente: gerar duas vezes no mesmo mês não duplica o título", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedTemplate(env);

    await runSkill(contasAPagarSkill, env.ctx(), { action: "generate_recurring" });
    const second = await runSkill(contasAPagarSkill, env.ctx(), { action: "generate_recurring" });

    expect(env.db.payables).toHaveLength(1);
    // Na segunda passada nada novo é gerado.
    expect((second.data as GenerateRecurringData).generated).toHaveLength(0);
  });

  it("não gera para template pausado, encerrado ou fora do período", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    seedTemplate(env, { status: "paused" });
    seedTemplate(env, { status: "ended" });
    seedTemplate(env, { startDate: "2026-12-01" }); // começa no futuro
    seedTemplate(env, { endDate: "2026-01-31" }); // já encerrou

    const res = await runSkill(contasAPagarSkill, env.ctx(), { action: "generate_recurring" });

    expect(res.status).toBe("success");
    expect((res.data as GenerateRecurringData).generated).toHaveLength(0);
    expect(env.db.payables).toHaveLength(0);
  });
});
