import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "@/core/clock";
import { addDays, todayInTz } from "@/core/dates";
import { MemoryDb } from "../db";
import { createMemoryRepositories } from "../repos";
import { DEMO_BANK_NUBANK_ID, DEMO_COMPANY_ID, seedDemoData } from "../demo-seed";

const NOW_ISO = "2026-08-18T15:00:00Z";

describe("seedDemoData", () => {
  const db = new MemoryDb();
  const repos = createMemoryRepositories(db);
  const clock = new FixedClock(NOW_ISO);
  const today = todayInTz(clock.now(), "America/Sao_Paulo");

  beforeAll(async () => {
    await seedDemoData(repos, clock);
  });

  it("cria cadastros base e as duas contas bancárias", () => {
    expect(db.companies.map((c) => c.id)).toContain(DEMO_COMPANY_ID);
    expect(db.users.length).toBeGreaterThanOrEqual(5);
    expect(db.suppliers.length).toBeGreaterThanOrEqual(6);
    expect(db.customers.length).toBeGreaterThanOrEqual(8);

    const nubank = db.bankAccounts.find((b) => b.id === DEMO_BANK_NUBANK_ID);
    expect(nubank).toBeDefined();
    expect(nubank?.bankCode).toBe("260");
    expect(nubank?.openingBalanceCents).toBe(1_830_000);
  });

  it("espalha contas a pagar: vencidas, próximas e futuras, todas em centavos inteiros", () => {
    expect(db.payables.length).toBeGreaterThanOrEqual(14);
    const open = db.payables.filter((p) => p.status === "open");
    const overdue = open.filter((p) => p.dueDate < today);
    const next7 = open.filter((p) => p.dueDate >= today && p.dueDate <= addDays(today, 7));
    expect(overdue.length).toBeGreaterThanOrEqual(3);
    expect(next7.length).toBeGreaterThanOrEqual(4);
    for (const p of db.payables) {
      expect(Number.isInteger(p.amountCents)).toBe(true);
      expect(Number.isInteger(p.paidCents)).toBe(true);
    }
  });

  it("planta um par de duplicatas (mesmo fornecedor+valor+vencimento, originKeys distintas)", () => {
    const byKey = new Map<string, string[]>();
    for (const p of db.payables.filter((x) => x.status === "open")) {
      const k = `${p.supplierId}|${p.amountCents}|${p.dueDate}`;
      byKey.set(k, [...(byKey.get(k) ?? []), p.originKey]);
    }
    const dupGroups = [...byKey.values()].filter((keys) => keys.length >= 2);
    expect(dupGroups.length).toBeGreaterThanOrEqual(1);
    // originKeys diferentes: passariam pela idempotência, só controles internos pegam
    expect(new Set(dupGroups[0]).size).toBe(dupGroups[0].length);
  });

  it("títulos pagos têm pagamento executado com aprovação de outro usuário", () => {
    const paid = db.payables.filter((p) => p.status === "paid");
    expect(paid.length).toBeGreaterThanOrEqual(2);
    for (const p of paid) {
      expect(p.paidCents).toBe(p.amountCents);
      const payment = db.payments.find((pm) => pm.payableId === p.id && pm.status === "executed");
      expect(payment).toBeDefined();
      expect(payment?.amountCents).toBe(p.amountCents);
      expect(payment?.approvalId).toBeDefined();
      const approval = db.approvals.find((a) => a.id === payment?.approvalId);
      expect(approval?.status).toBe("approved");
      expect(approval?.targetId).toBe(payment?.id);
      expect(approval?.decidedBy).toBeDefined();
      expect(approval?.decidedBy).not.toBe(approval?.requestedBy);
    }
  });

  it("recebíveis recebidos batem valores e têm recibo correspondente", () => {
    expect(db.receivables.length).toBeGreaterThanOrEqual(12);
    const received = db.receivables.filter((r) => r.status === "received");
    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const r of received) {
      expect(r.receivedCents).toBe(r.amountCents);
      const receipt = db.receipts.find((rc) => rc.receivableId === r.id);
      expect(receipt).toBeDefined();
      expect(receipt?.amountCents).toBe(r.amountCents);
    }
    const overdue = db.receivables.filter((r) => r.status === "open" && r.dueDate < today);
    expect(overdue.length).toBeGreaterThanOrEqual(4);
  });

  it("liga recebíveis a faturas emitidas com originKey inv:<id>:1/1", () => {
    const issued = db.invoices.filter((i) => i.status === "issued");
    const draft = db.invoices.filter((i) => i.status === "draft");
    expect(issued.length).toBeGreaterThanOrEqual(2);
    expect(draft.length).toBeGreaterThanOrEqual(1);
    for (const inv of issued) {
      expect(inv.nfeMock?.provider).toBe("mock");
      const linked = db.receivables.find((r) => r.invoiceId === inv.id);
      expect(linked).toBeDefined();
      expect(linked?.originKey).toBe(`inv:${inv.id}:1/1`);
      expect(linked?.amountCents).toBe(inv.totalCents);
    }
  });

  it("extrato: nada conciliado, com casamentos exatos para receipts e payments", () => {
    expect(db.bankTransactions.length).toBeGreaterThanOrEqual(20);
    expect(db.bankTransactions.every((t) => !t.reconciled)).toBe(true);
    expect(db.bankTransactions.every((t) => t.source === "csv" && t.externalId?.startsWith("seed-"))).toBe(true);

    for (const rc of db.receipts) {
      const match = db.bankTransactions.find(
        (t) => t.amountCents === rc.amountCents && t.date === rc.receivedDate
      );
      expect(match, `crédito casando com recibo ${rc.id}`).toBeDefined();
    }
    for (const pm of db.payments.filter((p) => p.status === "executed")) {
      const match = db.bankTransactions.find(
        (t) => t.amountCents === -pm.amountCents && t.date === pm.scheduledDate
      );
      expect(match, `débito casando com pagamento ${pm.id}`).toBeDefined();
    }
    // Débito de R$ 8,90 e crédito anômalo de R$ 12.000,00
    expect(db.bankTransactions.some((t) => t.amountCents === -890)).toBe(true);
    expect(db.bankTransactions.some((t) => t.amountCents === 1_200_000)).toBe(true);
  });

  it("cria orçamento do ano corrente com 4 períodos x 6 categorias", () => {
    const budget = db.budgets.find((b) => b.name === "Orçamento Anual");
    expect(budget).toBeDefined();
    expect(budget?.year).toBe(Number(today.slice(0, 4)));
    const lines = db.budgetLines.filter((l) => l.budgetId === budget?.id);
    expect(lines.length).toBe(24);
    expect(new Set(lines.map((l) => l.period)).size).toBe(4);
    expect(new Set(lines.map((l) => l.categoryId)).size).toBe(6);
    expect(new Set(lines.map((l) => l.period))).toContain(today.slice(0, 7));
  });

  it("mantém histórico de cobrança com mensagem enviada (etapa 1)", () => {
    const sent = db.collectionMessages.filter((m) => m.status === "sent" && m.step === 1);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const target = db.receivables.find((r) => r.id === sent[0].receivableId);
    expect(target).toBeDefined();
    expect(sent[0].customerId).toBe(target?.customerId);
    expect(sent[0].sentAt).toBeDefined();
  });

  it("é idempotente: rodar de novo não duplica registros", async () => {
    const counts = snapshot(db);
    await seedDemoData(repos, clock);
    expect(snapshot(db)).toEqual(counts);
  });
});

function snapshot(db: MemoryDb): Record<string, number> {
  return {
    companies: db.companies.length,
    users: db.users.length,
    suppliers: db.suppliers.length,
    customers: db.customers.length,
    bankAccounts: db.bankAccounts.length,
    bankTransactions: db.bankTransactions.length,
    payables: db.payables.length,
    receivables: db.receivables.length,
    payments: db.payments.length,
    receipts: db.receipts.length,
    approvals: db.approvals.length,
    invoices: db.invoices.length,
    budgets: db.budgets.length,
    budgetLines: db.budgetLines.length,
    collectionMessages: db.collectionMessages.length,
  };
}
