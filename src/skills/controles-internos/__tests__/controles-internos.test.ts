import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type {
  Approval,
  BankTransaction,
  Payable,
  Payment,
  ReconciliationMatch,
  Supplier,
} from "@/core/entities";
import { runSkill } from "@/core/skill";
import {
  controlesInternosSkill,
  type ExceptionReportData,
  type PostPaymentCheckData,
  type ScanAnomaliesData,
  type ValidatePayablesData,
  type VerifyAuditChainData,
} from "..";

// Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 em São Paulo.

let seq = 0;
const nextId = (prefix: string) => `${prefix}_seed_${++seq}`;

function seedSupplier(env: TestEnv, over: Partial<Supplier> = {}): Supplier {
  const now = env.clock.now().toISOString();
  const supplier: Supplier = {
    id: nextId("sup"),
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

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? nextId("payb");
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_x",
    description: "Serviço de manutenção",
    issueDate: "2026-08-01",
    dueDate: "2026-09-01",
    amountCents: 400_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(payable);
  return payable;
}

function seedPayment(env: TestEnv, over: Partial<Payment> = {}): Payment {
  const now = env.clock.now().toISOString();
  const payment: Payment = {
    id: nextId("pay"),
    companyId: env.company.id,
    payableId: "payb_x",
    bankAccountId: "ba_1",
    amountCents: 100_000,
    scheduledDate: "2026-08-18",
    executedAt: now,
    status: "executed",
    method: "pix",
    requestedBy: "usr_analyst",
    executedBy: "usr_approver",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payments.push(payment);
  return payment;
}

function seedApproval(env: TestEnv, over: Partial<Approval> = {}): Approval {
  const now = env.clock.now().toISOString();
  const approval: Approval = {
    id: nextId("apr"),
    companyId: env.company.id,
    targetType: "payment",
    targetId: "pay_x",
    summary: "Pagamento de fornecedor",
    amountCents: 100_000,
    requestedBy: "usr_analyst",
    requiredRole: "approver",
    status: "approved",
    decidedBy: "usr_approver",
    decidedAt: now,
    createdAt: now,
    ...over,
  };
  env.db.approvals.push(approval);
  return approval;
}

function seedBankTx(env: TestEnv, over: Partial<BankTransaction> = {}): BankTransaction {
  const tx: BankTransaction = {
    id: nextId("btx"),
    companyId: env.company.id,
    bankAccountId: "ba_1",
    date: "2026-08-15",
    amountCents: -50_000,
    currency: "BRL",
    description: "PIX FORNECEDOR",
    externalId: nextId("fit"),
    source: "ofx",
    reconciled: false,
    createdAt: env.clock.now().toISOString(),
    ...over,
  };
  env.db.bankTransactions.push(tx);
  return tx;
}

describe("controles_internos_auditoria — validate_payables", () => {
  it("caminho feliz: sem duplicata, alçada informada e cadastro completo", async () => {
    const env = createTestEnv();
    const supplier = seedSupplier(env);
    const payable = seedPayable(env, { supplierId: supplier.id, amountCents: 400_000 });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "validate_payables",
      payableIds: [payable.id],
    });

    expect(res.status).toBe("success");
    const data = res.data as ValidatePayablesData;
    expect(data.checks).toHaveLength(1);
    expect(data.checks[0]).toEqual({
      payableId: payable.id,
      duplicates: [],
      requiredRoleForPayment: "approver", // R$ 4.000 ≤ alçada de approver (R$ 5.000)
      issues: [],
    });
    expect(env.db.alerts).toHaveLength(0);
  });

  it("detecta duplicata plantada (mesmo fornecedor+valor+vencimento, originKey distinta)", async () => {
    const env = createTestEnv();
    const supplier = seedSupplier(env);
    const p1 = seedPayable(env, { supplierId: supplier.id, dueDate: "2026-09-01" });
    const p2 = seedPayable(env, { supplierId: supplier.id, dueDate: "2026-09-01" });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "validate_payables",
      payableIds: [p1.id],
    });

    expect(res.status).toBe("warning");
    const data = res.data as ValidatePayablesData;
    expect(data.checks[0].duplicates).toEqual([p2.id]);
    expect(data.checks[0].issues.length).toBeGreaterThan(0);
    const persisted = env.db.alerts.filter((a) => a.code === "possible_duplicate_payable");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].severity).toBe("warning");
    expect(persisted[0].entityId).toBe(p1.id);
  });

  it("ignora títulos cancelados na busca de duplicidade e detecta documento compartilhado", async () => {
    const env = createTestEnv();
    const supplier = seedSupplier(env);
    const p1 = seedPayable(env, { supplierId: supplier.id, documentId: "doc_1" });
    seedPayable(env, { supplierId: supplier.id, status: "canceled" }); // duplicata cancelada não conta
    const p3 = seedPayable(env, {
      supplierId: supplier.id,
      documentId: "doc_1",
      amountCents: 999_999, // valor diferente, mas mesmo documento fiscal
      dueDate: "2026-10-01",
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "validate_payables",
      payableIds: [p1.id],
    });

    const data = res.data as ValidatePayablesData;
    expect(data.checks[0].duplicates).toEqual([p3.id]);
  });

  it("aponta alçada por faixa e fornecedor sem documento", async () => {
    const env = createTestEnv();
    const supplierNoDoc = seedSupplier(env, { document: undefined });
    const mid = seedPayable(env, { supplierId: supplierNoDoc.id, amountCents: 600_000 });
    const big = seedPayable(env, { supplierId: supplierNoDoc.id, amountCents: 6_000_000 });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "validate_payables",
      payableIds: [mid.id, big.id],
    });

    expect(res.status).toBe("warning");
    const data = res.data as ValidatePayablesData;
    expect(data.checks[0].requiredRoleForPayment).toBe("finance_manager");
    expect(data.checks[1].requiredRoleForPayment).toBe("admin");
    expect(data.checks[0].issues.some((i) => i.includes("sem CNPJ/CPF"))).toBe(true);
  });
});

describe("controles_internos_auditoria — post_payment_check", () => {
  it("aprova caso válido: aprovação existente, segregada, dentro de alçada e papel", async () => {
    const env = createTestEnv();
    const approval = seedApproval(env, { decidedBy: "usr_approver", requiredRole: "approver" });
    const payment = seedPayment(env, {
      amountCents: 100_000,
      approvalId: approval.id,
      requestedBy: "usr_analyst",
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "post_payment_check",
      paymentId: payment.id,
    });

    expect(res.status).toBe("success");
    const data = res.data as PostPaymentCheckData;
    expect(data.checks).toHaveLength(5);
    expect(data.checks.every((c) => c.passed)).toBe(true);
    expect(data.checks.map((c) => c.rule)).toEqual([
      "approval_exists",
      "approval_approved",
      "segregation",
      "approver_limit",
      "approver_role",
    ]);
    expect(env.db.alerts).toHaveLength(0);
    expect(env.db.events.filter((e) => e.type === "controls.anomaly_detected")).toHaveLength(0);
  });

  it("acusa auto-aprovação (segregação) com alerta crítico e evento", async () => {
    const env = createTestEnv();
    const approval = seedApproval(env, {
      requestedBy: "usr_manager",
      decidedBy: "usr_manager",
      requiredRole: "approver",
    });
    const payment = seedPayment(env, {
      amountCents: 100_000,
      approvalId: approval.id,
      requestedBy: "usr_manager",
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "post_payment_check",
      paymentId: payment.id,
    });

    expect(res.status).toBe("error"); // violação de regra crítica
    const data = res.data as PostPaymentCheckData;
    const segregation = data.checks.find((c) => c.rule === "segregation");
    expect(segregation?.passed).toBe(false);
    const persisted = env.db.alerts.filter((a) => a.code === "control_violation");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].severity).toBe("critical");
    expect(persisted[0].entityId).toBe(payment.id);
    expect(env.db.events.filter((e) => e.type === "controls.anomaly_detected")).toHaveLength(1);
  });

  it("acusa estouro do limite de alçada do aprovador (warning)", async () => {
    const env = createTestEnv();
    // usr_approver tem limite de R$ 5.000 (500_000 centavos) no createTestEnv.
    const approval = seedApproval(env, {
      decidedBy: "usr_approver",
      requiredRole: "approver",
      amountCents: 600_000,
    });
    const payment = seedPayment(env, {
      amountCents: 600_000,
      approvalId: approval.id,
      requestedBy: "usr_analyst",
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "post_payment_check",
      paymentId: payment.id,
    });

    expect(res.status).toBe("warning"); // falha de alçada, não de regra crítica
    const data = res.data as PostPaymentCheckData;
    expect(data.checks.find((c) => c.rule === "approver_limit")?.passed).toBe(false);
    expect(data.checks.find((c) => c.rule === "approver_role")?.passed).toBe(true);
    expect(data.checks.find((c) => c.rule === "segregation")?.passed).toBe(true);
    expect(env.db.alerts.filter((a) => a.code === "control_violation")).toHaveLength(1);
  });

  it("acusa pagamento sem aprovação vinculada (error)", async () => {
    const env = createTestEnv();
    const payment = seedPayment(env, { approvalId: undefined });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "post_payment_check",
      paymentId: payment.id,
    });

    expect(res.status).toBe("error");
    const data = res.data as PostPaymentCheckData;
    expect(data.checks.find((c) => c.rule === "approval_exists")?.passed).toBe(false);
    expect(env.db.alerts.filter((a) => a.code === "control_violation")).toHaveLength(1);
  });
});

describe("controles_internos_auditoria — scan_anomalies", () => {
  it("acha pagamento sem aprovação, transação duplicada e sobrepagamento", async () => {
    const env = createTestEnv();
    // (c) Pagamento executado sem approvalId — crítico.
    const noApproval = seedPayment(env, { approvalId: undefined, payableId: "payb_solo" });
    seedPayable(env, { id: "payb_solo", amountCents: 500_000 });
    // (a) Transações duplicadas: mesmo valor+data+descrição, externalId diferente.
    const t1 = seedBankTx(env, { externalId: "fit_a" });
    const t2 = seedBankTx(env, { externalId: "fit_b" });
    // (d) Dois pagamentos executados somando mais que o título.
    const over = seedPayable(env, { amountCents: 50_000 });
    seedPayment(env, { payableId: over.id, amountCents: 30_000, approvalId: "apr_1" });
    seedPayment(env, { payableId: over.id, amountCents: 30_000, approvalId: "apr_2" });

    const res = await runSkill(controlesInternosSkill, env.ctx(), { action: "scan_anomalies" });

    expect(res.status).toBe("warning");
    const data = res.data as ScanAnomaliesData;
    const byType = (t: string) => data.anomalies.filter((a) => a.type === t);

    expect(byType("payment_without_approval")).toHaveLength(1);
    expect(byType("payment_without_approval")[0].entityId).toBe(noApproval.id);
    expect(byType("payment_without_approval")[0].severity).toBe("critical");

    expect(byType("duplicate_bank_transaction")).toHaveLength(1);
    expect(byType("duplicate_bank_transaction")[0].entityId).toBe([t1.id, t2.id].sort().join("+"));

    expect(byType("overpayment")).toHaveLength(1);
    expect(byType("overpayment")[0].entityId).toBe(over.id);
    expect(byType("overpayment")[0].severity).toBe("critical");

    // Conta com < 5 transações: análise de valor atípico pulada com assumption.
    expect(res.assumptions.some((a) => a.includes("amostra insuficiente"))).toBe(true);

    // Alertas persistidos e eventos publicados para cada anomalia.
    expect(env.db.alerts).toHaveLength(3);
    expect(env.db.events.filter((e) => e.type === "controls.anomaly_detected")).toHaveLength(3);

    // Reexecução não duplica alertas (dedupe por code+entityId).
    await runSkill(controlesInternosSkill, env.ctx(), { action: "scan_anomalies" });
    expect(env.db.alerts).toHaveLength(3);
  });

  it("aponta valor atípico (> 3x a média) quando a conta tem 5+ transações", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 5; i++) {
      seedBankTx(env, { amountCents: -10_000, date: `2026-08-1${i}`, description: `Tarifa ${i}` });
    }
    const outlier = seedBankTx(env, {
      amountCents: -900_000,
      date: "2026-08-16",
      description: "Transferência atípica",
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), { action: "scan_anomalies" });
    const data = res.data as ScanAnomaliesData;
    const found = data.anomalies.filter((a) => a.type === "unusual_transaction_amount");
    expect(found).toHaveLength(1);
    expect(found[0].entityId).toBe(outlier.id);
  });

  it("com 12+ transações usa escore robusto (mediana/MAD): outlier claro é marcado, demais não", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 12; i++) {
      seedBankTx(env, {
        amountCents: -10_000,
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        description: `Tarifa mensal ${i}`,
      });
    }
    const outlier = seedBankTx(env, {
      amountCents: -900_000,
      date: "2026-08-16",
      description: "Transferência atípica",
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), { action: "scan_anomalies" });
    const found = (res.data as ScanAnomaliesData).anomalies.filter(
      (a) => a.type === "unusual_transaction_amount"
    );
    expect(found).toHaveLength(1);
    expect(found[0].entityId).toBe(outlier.id);
    expect(found[0].detail).toContain("Iglewicz");
    expect(res.assumptions.some((a) => a.includes("escore robusto"))).toBe(true);
  });

  it("guarda de 2× mediana: em série quase constante, desvio pequeno NÃO vira anomalia", async () => {
    const env = createTestEnv();
    // 12 valores idênticos → MAD 0 (escore degenera em infinito); a guarda de
    // 2× mediana impede que uma variação de 1,5× seja marcada como atípica.
    for (let i = 0; i < 12; i++) {
      seedBankTx(env, {
        amountCents: -10_000,
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        description: `Assinatura ${i}`,
      });
    }
    seedBankTx(env, { amountCents: -15_000, date: "2026-08-16", description: "Assinatura reajustada" });

    const res = await runSkill(controlesInternosSkill, env.ctx(), { action: "scan_anomalies" });
    const found = (res.data as ScanAnomaliesData).anomalies.filter(
      (a) => a.type === "unusual_transaction_amount"
    );
    expect(found).toHaveLength(0);
  });

  it("sem anomalias: resultado limpo e nenhum alerta", async () => {
    const env = createTestEnv();
    const payable = seedPayable(env, { amountCents: 100_000 });
    seedPayment(env, { payableId: payable.id, amountCents: 100_000, approvalId: "apr_ok" });

    const res = await runSkill(controlesInternosSkill, env.ctx(), { action: "scan_anomalies" });
    expect((res.data as ScanAnomaliesData).anomalies).toHaveLength(0);
    expect(env.db.alerts).toHaveLength(0);
  });
});

describe("controles_internos_auditoria — verify_audit_chain", () => {
  it("cadeia íntegra é validada", async () => {
    const env = createTestEnv();
    await env.audit.record(env.company.id, {
      actor: env.actorFor("analyst"),
      action: "payable.created",
      entityType: "payable",
      entityId: "payb_1",
      after: { amountCents: 100 },
    });
    await env.audit.record(env.company.id, {
      actor: env.actorFor("analyst"),
      action: "payable.updated",
      entityType: "payable",
      entityId: "payb_1",
      after: { amountCents: 200 },
    });

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "verify_audit_chain",
    });

    expect(res.status).toBe("success");
    const data = res.data as VerifyAuditChainData;
    expect(data.valid).toBe(true);
    expect(data.brokenAtSeq).toBeUndefined();
    expect(data.totalRecords).toBe(2);
    expect(env.db.alerts).toHaveLength(0);
  });

  it("cadeia adulterada é detectada com alerta crítico", async () => {
    const env = createTestEnv();
    await env.audit.record(env.company.id, {
      actor: env.actorFor("analyst"),
      action: "payment.executed",
      entityType: "payment",
      entityId: "pay_1",
      after: { amountCents: 100_000 },
    });
    await env.audit.record(env.company.id, {
      actor: env.actorFor("analyst"),
      action: "payment.executed",
      entityType: "payment",
      entityId: "pay_2",
      after: { amountCents: 200_000 },
    });
    // Adulteração direta do registro imutável (simula fraude no banco).
    env.db.auditRecords[0].after = { amountCents: 999_999 };

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "verify_audit_chain",
    });

    expect(res.status).toBe("warning");
    const data = res.data as VerifyAuditChainData;
    expect(data.valid).toBe(false);
    expect(data.brokenAtSeq).toBe(1);
    expect(data.totalRecords).toBe(2);
    const persisted = env.db.alerts.filter((a) => a.code === "audit_chain_broken");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].severity).toBe("critical");
    expect(env.db.events.filter((e) => e.type === "controls.anomaly_detected")).toHaveLength(1);
  });
});

describe("controles_internos_auditoria — exception_report", () => {
  it("consolida alertas abertos, aprovações antigas, conciliações e integridade", async () => {
    const env = createTestEnv();
    // Alerta aberto plantado.
    env.db.alerts.push({
      id: "alr_seed",
      companyId: env.company.id,
      severity: "critical",
      code: "payable_overdue",
      message: "Título vencido",
      source: "contas_a_pagar",
      status: "open",
      createdAt: env.clock.now().toISOString(),
    });
    // Aprovação pendente há 8 dias (> 3).
    seedApproval(env, {
      status: "pending",
      decidedBy: undefined,
      decidedAt: undefined,
      createdAt: "2026-08-10T12:00:00Z",
    });
    // Aprovação pendente recente (não entra).
    seedApproval(env, {
      status: "pending",
      decidedBy: undefined,
      decidedAt: undefined,
      createdAt: "2026-08-17T12:00:00Z",
    });
    // Sugestão de conciliação pendente.
    const match: ReconciliationMatch = {
      id: "rm_seed",
      companyId: env.company.id,
      bankTransactionId: "btx_1",
      targetType: "payable",
      targetId: "payb_1",
      confidence: 0.7,
      status: "suggested",
      matchedBy: "system",
      createdAt: env.clock.now().toISOString(),
      updatedAt: env.clock.now().toISOString(),
    };
    env.db.reconciliations.push(match);

    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "exception_report",
    });

    expect(res.status).toBe("warning");
    const data = res.data as ExceptionReportData;
    const section = (id: string) => data.sections.find((s) => s.id === id);
    expect(data.sections).toHaveLength(4);
    expect(section("open_alerts")?.count).toBe(1);
    expect(section("stale_approvals")?.count).toBe(1);
    expect(section("pending_reconciliations")?.count).toBe(1);
    expect(section("audit_chain")?.count).toBe(0); // cadeia íntegra
    expect(res.pending_items.map((p) => p.code)).toEqual(
      expect.arrayContaining(["stale_approval", "reconciliation_suggested"])
    );
  });

  it("sem exceções devolve sucesso", async () => {
    const env = createTestEnv();
    const res = await runSkill(controlesInternosSkill, env.ctx(), {
      action: "exception_report",
    });
    expect(res.status).toBe("success");
    expect(res.pending_items).toHaveLength(0);
  });
});
