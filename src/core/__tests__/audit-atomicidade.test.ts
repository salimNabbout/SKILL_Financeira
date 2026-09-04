/**
 * A trilha commita JUNTO com a escrita financeira.
 *
 * Antes, `withTransaction` fechava a transação e o `audit.record` rodava
 * depois: se o registro falhasse (ele desiste após 5 colisões de seq), a
 * movimentação ficava commitada e sem rastro — o pior resultado possível para
 * uma auditoria, porque nada denuncia a falta.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { BankAccount, Payable, Payment } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { contasAPagarSkill } from "@/skills/contas-a-pagar";

const TODAY = "2026-08-18";

function seedCenario(env: TestEnv): { payable: Payable; payment: Payment } {
  const now = env.clock.now().toISOString();
  env.db.suppliers.push({
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Alfa Ltda",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  const conta: BankAccount = {
    id: "ba_1",
    companyId: env.company.id,
    name: "Conta Principal",
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
  };
  env.db.bankAccounts.push(conta);
  const payable: Payable = {
    id: "payb_1",
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Serviço",
    issueDate: "2026-08-01",
    dueDate: "2026-08-20",
    amountCents: 50_000,
    paidCents: 0,
    currency: "BRL",
    status: "scheduled",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: "seed:payb_1:1/1",
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  };
  env.db.payables.push(payable);
  const payment: Payment = {
    id: "pay_1",
    companyId: env.company.id,
    payableId: payable.id,
    bankAccountId: conta.id,
    amountCents: 50_000,
    scheduledDate: TODAY,
    status: "approved",
    approvalId: "apr_1",
    requestedBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
  };
  env.db.payments.push(payment);
  return { payable, payment };
}

describe("auditoria atômica com a escrita financeira", () => {
  it("falha ao gravar a trilha DESFAZ a conciliação do pagamento", async () => {
    const env = createTestEnv();
    const { payable, payment } = seedCenario(env);

    // Trilha quebrada: todo append falha, como se a cadeia tivesse esgotado as
    // tentativas de resolver colisão de seq.
    const original = env.repos.audit.appendWithHead.bind(env.repos.audit);
    env.repos.audit.appendWithHead = async () => {
      throw new Error("falha simulada no append da trilha");
    };

    const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("manager")), {
      action: "reconcile_payment",
      paymentId: payment.id,
      paymentDate: TODAY,
    });

    env.repos.audit.appendWithHead = original;

    // A ação falha…
    expect(res.status).toBe("error");
    // …e NADA foi commitado: pagamento segue aprovado, título sem baixa.
    const pagamento = await env.repos.payments.getById(env.company.id, payment.id);
    expect(pagamento?.status).toBe("approved");
    expect(pagamento?.executedAt).toBeUndefined();
    const titulo = await env.repos.payables.getById(env.company.id, payable.id);
    expect(titulo?.paidCents).toBe(0);
    expect(titulo?.status).toBe("scheduled");
    // Nenhum registro de trilha meia-boca ficou para trás.
    expect(env.db.auditRecords.filter((a) => a.action === "payment.executed")).toHaveLength(0);
  });

  it("caminho normal: pagamento, título e trilha commitam juntos", async () => {
    const env = createTestEnv();
    const { payable, payment } = seedCenario(env);

    const res = await runSkill(contasAPagarSkill, env.ctx(env.actorFor("manager")), {
      action: "reconcile_payment",
      paymentId: payment.id,
      paymentDate: TODAY,
    });

    expect(res.status).toBe("success");
    expect((await env.repos.payments.getById(env.company.id, payment.id))?.status).toBe("executed");
    expect((await env.repos.payables.getById(env.company.id, payable.id))?.status).toBe("paid");
    expect(env.db.auditRecords.some((a) => a.action === "payment.executed")).toBe(true);
    expect(env.db.auditRecords.some((a) => a.action === "payable.updated")).toBe(true);
  });

  it("append e head são gravados juntos: head nunca fica atrasado", async () => {
    const env = createTestEnv();
    await env.audit.record(env.company.id, {
      actor: env.actorFor("manager"),
      action: "payable.updated",
      entityType: "payable",
      entityId: "payb_x",
    });

    const head = await env.repos.audit.getHead(env.company.id);
    const ultimo = env.db.auditRecords[env.db.auditRecords.length - 1];
    expect(head?.seq).toBe(ultimo.seq);
    expect(head?.hash).toBe(ultimo.hash);
  });
});
