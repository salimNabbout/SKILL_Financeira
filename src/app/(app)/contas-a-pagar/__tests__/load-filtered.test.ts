import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Payable, Payment } from "@/core/entities";
import { parsePayableFilters } from "../_lib/filters";
import { loadFilteredPayables } from "../_lib/load-filtered";

/**
 * Carga da exportação: a "Data de Pagamento" por título é a MAIOR data de
 * conciliação entre os pagamentos executados, no fuso da empresa — a mesma
 * regra do badge Pago / Pago no Vencimento / Pago Atrasado da tela.
 */

const HOJE = "2026-08-20";
const TZ = "America/Sao_Paulo";

async function seed(env: TestEnv) {
  const now = env.clock.now().toISOString();
  await env.repos.suppliers.create({
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Alfa Ltda",
    document: "11.222.333/0001-44",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await env.repos.bankAccounts.create({
    id: "ba_1",
    companyId: env.company.id,
    name: "Conta Principal",
    bankCode: "341",
    agency: "0001",
    accountNumberMasked: "****-1234",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 1_000_000,
    openingBalanceDate: "2026-01-01",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
}

function payable(env: TestEnv, over: Partial<Payable> & { id: string }): Payable {
  const now = env.clock.now().toISOString();
  return {
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Título",
    issueDate: "2026-07-01",
    dueDate: "2026-08-18",
    amountCents: 10_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `k_${over.id}`,
    createdBy: "usr",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function payment(env: TestEnv, over: Partial<Payment> & { id: string; payableId: string }): Payment {
  const now = env.clock.now().toISOString();
  return {
    companyId: env.company.id,
    bankAccountId: "ba_1",
    amountCents: 10_000,
    scheduledDate: "2026-08-18",
    status: "executed",
    requestedBy: "usr",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("Contas a pagar — carga da exportação (Data de Pagamento)", () => {
  it("usa a maior data de conciliação dos pagamentos executados, no fuso da empresa", async () => {
    const env = createTestEnv();
    await seed(env);
    await env.repos.payables.create(payable(env, { id: "pv_1", status: "paid", paidCents: 10_000 }));
    // Dois pagamentos executados (baixa em duas vezes): vale o mais recente.
    await env.repos.payments.create(
      payment(env, { id: "pay_a", payableId: "pv_1", amountCents: 4_000, executedAt: "2026-08-10T12:00:00.000Z" })
    );
    await env.repos.payments.create(
      payment(env, { id: "pay_b", payableId: "pv_1", amountCents: 6_000, executedAt: "2026-08-18T12:00:00.000Z" })
    );
    // Pagamento cancelado (estornado) não conta, mesmo com executedAt gravado.
    await env.repos.payments.create(
      payment(env, { id: "pay_c", payableId: "pv_1", status: "canceled", executedAt: "2026-08-25T12:00:00.000Z" })
    );

    const dados = await loadFilteredPayables(env.repos, env.company.id, parsePayableFilters({ status: "todos" }, HOJE), TZ);

    expect(dados.lookups.paymentDateByPayable?.get("pv_1")).toBe("2026-08-18");
  });

  it("converte o executedAt (UTC) para a data local: 02h30 UTC de 19/08 ainda é 18/08 em São Paulo", async () => {
    const env = createTestEnv();
    await seed(env);
    await env.repos.payables.create(payable(env, { id: "pv_1", status: "paid", paidCents: 10_000 }));
    await env.repos.payments.create(
      payment(env, { id: "pay_a", payableId: "pv_1", executedAt: "2026-08-19T02:30:00.000Z" })
    );

    const dados = await loadFilteredPayables(env.repos, env.company.id, parsePayableFilters({ status: "todos" }, HOJE), TZ);

    expect(dados.lookups.paymentDateByPayable?.get("pv_1")).toBe("2026-08-18");
  });

  it("título sem pagamento executado (em aberto ou baixado pela conciliação bancária) fica sem data; sem fuso, nada é calculado", async () => {
    const env = createTestEnv();
    await seed(env);
    await env.repos.payables.create(payable(env, { id: "aberto" }));
    await env.repos.payables.create(payable(env, { id: "baixado", status: "paid", paidCents: 10_000 }));
    await env.repos.payables.create(payable(env, { id: "pago", status: "paid", paidCents: 10_000 }));
    await env.repos.payments.create(
      payment(env, { id: "pay_a", payableId: "pago", executedAt: "2026-08-18T12:00:00.000Z" })
    );

    const comFuso = await loadFilteredPayables(env.repos, env.company.id, parsePayableFilters({ status: "todos" }, HOJE), TZ);
    expect(comFuso.lookups.paymentDateByPayable?.has("aberto")).toBe(false);
    expect(comFuso.lookups.paymentDateByPayable?.has("baixado")).toBe(false);
    expect(comFuso.lookups.paymentDateByPayable?.get("pago")).toBe("2026-08-18");

    const semFuso = await loadFilteredPayables(env.repos, env.company.id, parsePayableFilters({ status: "todos" }, HOJE));
    expect(semFuso.lookups.paymentDateByPayable?.size ?? 0).toBe(0);
  });
});
