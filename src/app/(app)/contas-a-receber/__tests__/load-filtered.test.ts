import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Receipt, Receivable } from "@/core/entities";
import { parseReceivableFilters } from "../_lib/filters";
import { loadFilteredReceivables } from "../_lib/load-filtered";

/**
 * Carga da exportação: a "Data de Recebimento" por título é a MAIOR data entre
 * os recebimentos ATIVOS (estornado não conta) — a mesma regra do badge
 * Recebido / Recebido no Vencimento / Recebido em Atraso da tela.
 */

const HOJE = "2026-08-20";

async function seed(env: TestEnv) {
  const now = env.clock.now().toISOString();
  await env.repos.customers.create({
    id: "cus_1",
    companyId: env.company.id,
    name: "Cliente Alfa Ltda",
    document: "98.765.432/0001-10",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
}

function receivable(env: TestEnv, over: Partial<Receivable> & { id: string }): Receivable {
  const now = env.clock.now().toISOString();
  return {
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Título",
    issueDate: "2026-07-01",
    dueDate: "2026-08-18",
    amountCents: 10_000,
    receivedCents: 0,
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

function receipt(env: TestEnv, over: Partial<Receipt> & { id: string; receivableId: string; receivedDate: string }): Receipt {
  return {
    companyId: env.company.id,
    amountCents: 10_000,
    method: "pix",
    registeredBy: "usr",
    createdAt: env.clock.now().toISOString(),
    ...over,
  };
}

describe("Contas a receber — carga da exportação (Data de Recebimento)", () => {
  it("usa a maior data entre os recebimentos ativos; recebimento estornado não conta", async () => {
    const env = createTestEnv();
    await seed(env);
    await env.repos.receivables.create(receivable(env, { id: "rc_1", status: "received", receivedCents: 10_000 }));
    await env.repos.receipts.create(receipt(env, { id: "rcp_a", receivableId: "rc_1", amountCents: 4_000, receivedDate: "2026-08-10" }));
    await env.repos.receipts.create(receipt(env, { id: "rcp_b", receivableId: "rc_1", amountCents: 6_000, receivedDate: "2026-08-19" }));
    await env.repos.receipts.create(
      receipt(env, { id: "rcp_c", receivableId: "rc_1", receivedDate: "2026-08-25", status: "canceled", canceledAt: "2026-08-26T12:00:00.000Z" })
    );

    const dados = await loadFilteredReceivables(env.repos, env.company.id, parseReceivableFilters({ status: "todos" }, HOJE));

    expect(dados.lookups.receivedDateByReceivable?.get("rc_1")).toBe("2026-08-19");
  });

  it("título sem recebimento ativo fica sem data", async () => {
    const env = createTestEnv();
    await seed(env);
    await env.repos.receivables.create(receivable(env, { id: "aberto" }));
    await env.repos.receivables.create(receivable(env, { id: "recebido", status: "received", receivedCents: 10_000 }));
    await env.repos.receipts.create(receipt(env, { id: "rcp_a", receivableId: "recebido", receivedDate: "2026-08-18" }));

    const dados = await loadFilteredReceivables(env.repos, env.company.id, parseReceivableFilters({ status: "todos" }, HOJE));

    expect(dados.lookups.receivedDateByReceivable?.has("aberto")).toBe(false);
    expect(dados.lookups.receivedDateByReceivable?.get("recebido")).toBe("2026-08-18");
  });
});
