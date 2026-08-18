/**
 * Baixas parciais, rateio multi-parcela e transferências entre contas.
 * Relógio fixo do createTestEnv: 2026-08-18T15:00:00Z → "hoje" = 2026-08-18 (SP).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { BankTransaction, Payable, Receivable } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { conciliacaoSkill, type AutoMatchData, type ConfirmMatchData } from "..";

let env: TestEnv;
let seq = 0;

beforeEach(() => {
  env = createTestEnv();
  seq = 0;
  const now = env.clock.now().toISOString();
  for (const id of ["ba_1", "ba_2"]) {
    env.db.bankAccounts.push({
      id,
      companyId: env.company.id,
      name: id === "ba_1" ? "Conta Principal" : "Conta Reserva",
      bankCode: "341",
      agency: "0001",
      accountNumberMasked: `***${id}`,
      type: "checking",
      currency: "BRL",
      openingBalanceCents: 1_000_000,
      openingBalanceDate: "2026-01-01",
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  env.db.customers.push({
    id: "cus_1",
    companyId: env.company.id,
    name: "Cliente Beta Ltda",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  env.db.suppliers.push({
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Gama Ltda",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
});

function seedReceivable(over: Partial<Receivable>): Receivable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `rcv_${++seq}`;
  const r: Receivable = {
    id,
    companyId: env.company.id,
    customerId: "cus_1",
    description: "Fatura de serviços",
    issueDate: "2026-08-01",
    dueDate: "2026-08-18",
    amountCents: 150_000,
    receivedCents: 0,
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
  env.db.receivables.push(r);
  return r;
}

function seedPayable(over: Partial<Payable>): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const p: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "NF de insumos",
    issueDate: "2026-08-01",
    dueDate: "2026-08-18",
    amountCents: 150_000,
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
  env.db.payables.push(p);
  return p;
}

function seedTx(over: Partial<BankTransaction> & { amountCents: number }): BankTransaction {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `btx_${++seq}`;
  const tx: BankTransaction = {
    id,
    companyId: env.company.id,
    bankAccountId: "ba_1",
    date: "2026-08-18",
    currency: "BRL",
    description: "movimentação",
    externalId: `ext:${id}`,
    source: "csv",
    reconciled: false,
    createdAt: now,
    ...over,
  };
  env.db.bankTransactions.push(tx);
  return tx;
}

async function autoMatch(): Promise<AutoMatchData> {
  const res = await runSkill(conciliacaoSkill, env.ctx(), { action: "auto_match" });
  expect(res.status).not.toBe("error");
  return res.data as AutoMatchData;
}

describe("baixa parcial (1 transação menor que o título)", () => {
  it("sugere porção com nome obrigatório e NUNCA auto-confirma; confirmação aplica baixa parcial", async () => {
    const r = seedReceivable({ amountCents: 150_000 });
    const tx = seedTx({ amountCents: 50_000, description: "PIX CLIENTE BETA parcela" });

    const data = await autoMatch();
    // score 0,45 + 0,20 nome + 0,25 data = 0,90 (>= limiar), mas parcial nunca é automática.
    expect(data.autoConfirmed).toBe(0);
    expect(data.suggested).toBe(1);
    const match = data.matches[0];
    expect(match.status).toBe("suggested");
    expect(match.amountCents).toBe(50_000);
    expect(match.targetId).toBe(r.id);

    const confirm = await runSkill(conciliacaoSkill, env.ctx(), {
      action: "confirm_match",
      matchId: match.id,
    });
    const cData = confirm.data as ConfirmMatchData;
    expect(cData.receipt?.amountCents).toBe(50_000);

    const updated = await env.repos.receivables.getById(env.company.id, r.id);
    expect(updated?.receivedCents).toBe(50_000);
    expect(updated?.status).toBe("partially_received");
    const txAfter = await env.repos.bankTransactions.getById(env.company.id, tx.id);
    expect(txAfter?.reconciled).toBe(true);
  });

  it("sem o nome da contraparte na descrição, não propõe baixa parcial", async () => {
    seedReceivable({ amountCents: 150_000 });
    seedTx({ amountCents: 50_000, description: "PIX RECEBIDO 1234" });
    const data = await autoMatch();
    expect(data.suggested).toBe(0);
    expect(data.unmatched).toBe(1);
  });

  it("segunda transação parcial completa o título via fase 1 (valor exato do saldo)", async () => {
    const r = seedReceivable({ amountCents: 150_000, receivedCents: 50_000, status: "partially_received" });
    seedTx({ amountCents: 100_000, description: "PIX CLIENTE BETA quitação" });
    const data = await autoMatch();
    expect(data.autoConfirmed).toBe(1); // 0,55 + 0,25 + 0,20 = 1,00
    const updated = await env.repos.receivables.getById(env.company.id, r.id);
    expect(updated?.status).toBe("received");
    expect(updated?.receivedCents).toBe(150_000);
  });
});

describe("rateio: 1 transação ↔ N parcelas da mesma contraparte", () => {
  it("soma exata com nome e vencimentos na tolerância → automático com uma baixa por parcela", async () => {
    const r1 = seedReceivable({ amountCents: 100_000, dueDate: "2026-08-15" });
    const r2 = seedReceivable({ amountCents: 80_000, dueDate: "2026-08-18" });
    const tx = seedTx({ amountCents: 180_000, description: "TED CLIENTE BETA LTDA PED 10-11" });

    const data = await autoMatch();
    expect(data.autoConfirmed).toBe(1); // 0,55 + 0,20 + 0,15 = 0,90
    expect(data.matches).toHaveLength(2);
    const [m1, m2] = data.matches;
    expect(m1.groupId).toBeTruthy();
    expect(m1.groupId).toBe(m2.groupId);
    expect(new Set(data.matches.map((m) => m.amountCents))).toEqual(new Set([100_000, 80_000]));

    for (const r of [r1, r2]) {
      const updated = await env.repos.receivables.getById(env.company.id, r.id);
      expect(updated?.status).toBe("received");
    }
    const receipts = await env.repos.receipts.listByDateRange(env.company.id, "2026-08-18", "2026-08-18");
    expect(receipts.map((x) => x.amountCents).sort((a, b) => a - b)).toEqual([80_000, 100_000]);
    expect((await env.repos.bankTransactions.getById(env.company.id, tx.id))?.reconciled).toBe(true);
  });

  it("sem nome na descrição vira sugestão; confirmar UM match aplica o grupo inteiro", async () => {
    const r1 = seedPayable({ amountCents: 60_000, dueDate: "2026-08-17" });
    const r2 = seedPayable({ amountCents: 40_000, dueDate: "2026-08-18" });
    const tx = seedTx({ amountCents: -100_000, description: "PAGAMENTO 998877" });

    const data = await autoMatch();
    expect(data.autoConfirmed).toBe(0); // 0,55 + 0,15 = 0,70
    expect(data.suggested).toBe(1); // 1 grupo sugerido (2 matches)
    expect(data.matches).toHaveLength(2);

    const confirm = await runSkill(conciliacaoSkill, env.ctx(), {
      action: "confirm_match",
      matchId: data.matches[0].id,
    });
    const cData = confirm.data as ConfirmMatchData;
    expect(cData.matches).toHaveLength(2);
    expect(cData.matches?.every((m) => m.status === "confirmed")).toBe(true);

    for (const p of [r1, r2]) {
      const updated = await env.repos.payables.getById(env.company.id, p.id);
      expect(updated?.status).toBe("paid");
    }
    expect((await env.repos.bankTransactions.getById(env.company.id, tx.id))?.reconciled).toBe(true);
  });

  it("rejeitar UM match rejeita o grupo inteiro e libera a transação", async () => {
    seedReceivable({ amountCents: 60_000 });
    seedReceivable({ amountCents: 40_000 });
    const tx = seedTx({ amountCents: 100_000, description: "CREDITO SEM NOME" });

    const data = await autoMatch();
    expect(data.suggested).toBe(1);
    await runSkill(conciliacaoSkill, env.ctx(), {
      action: "reject_match",
      matchId: data.matches[1].id,
      notes: "não é desse cliente",
    });

    const all = await env.repos.reconciliations.listAll(env.company.id);
    expect(all.every((m) => m.status === "rejected")).toBe(true);
    expect((await env.repos.bankTransactions.getById(env.company.id, tx.id))?.reconciled).toBe(false);
    expect(await env.repos.receipts.listByDateRange(env.company.id, "2026-01-01", "2026-12-31")).toHaveLength(0);
  });
});

describe("transferências entre contas", () => {
  it("par oposto exato com palavra-chave e mesma data → automático, sem receita/despesa", async () => {
    const out = seedTx({ amountCents: -80_000, bankAccountId: "ba_1", description: "TED TRANSFERENCIA ENTRE CONTAS" });
    const inn = seedTx({ amountCents: 80_000, bankAccountId: "ba_2", description: "TED RECEBIDA" });

    const data = await autoMatch();
    expect(data.transferPairs).toBe(1);
    expect(data.autoConfirmed).toBe(1); // 0,55 + 0,25 + 0,20 = 1,00
    expect(data.matches).toHaveLength(2);
    expect(data.matches.every((m) => m.targetType === "transfer")).toBe(true);
    expect(data.matches[0].groupId).toBe(data.matches[1].groupId);

    for (const tx of [out, inn]) {
      expect((await env.repos.bankTransactions.getById(env.company.id, tx.id))?.reconciled).toBe(true);
    }
    // Nenhuma receita/despesa registrada.
    expect(env.db.receipts).toHaveLength(0);
    expect(env.db.payables).toHaveLength(0);
  });

  it("sem palavra-chave e com datas próximas vira sugestão; confirmação concilia o par", async () => {
    const out = seedTx({ amountCents: -55_000, bankAccountId: "ba_1", date: "2026-08-16", description: "ENVIO 0099" });
    const inn = seedTx({ amountCents: 55_000, bankAccountId: "ba_2", date: "2026-08-18", description: "CREDITO 0099" });

    const data = await autoMatch();
    expect(data.transferPairs).toBe(1);
    expect(data.suggested).toBe(1); // 0,55 + 0,15 = 0,70
    expect((await env.repos.bankTransactions.getById(env.company.id, out.id))?.reconciled).toBe(false);

    const confirm = await runSkill(conciliacaoSkill, env.ctx(), {
      action: "confirm_match",
      matchId: data.matches[0].id,
    });
    expect((confirm.data as ConfirmMatchData).matches).toHaveLength(2);
    for (const tx of [out, inn]) {
      expect((await env.repos.bankTransactions.getById(env.company.id, tx.id))?.reconciled).toBe(true);
    }
  });

  it("transações opostas na MESMA conta não formam par de transferência", async () => {
    seedTx({ amountCents: -30_000, bankAccountId: "ba_1", description: "SAQUE" });
    seedTx({ amountCents: 30_000, bankAccountId: "ba_1", description: "DEPOSITO" });
    const data = await autoMatch();
    expect(data.transferPairs).toBe(0);
    expect(data.unmatched).toBe(2);
  });
});
