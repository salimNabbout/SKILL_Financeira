/**
 * Testes do adaptador Prisma SEM banco vivo: os delegates do PrismaClient são
 * substituídos por stubs. Valida as conversões de borda (BigInt<->centavos,
 * @db.Date<->ISODate, DateTime<->ISO string, Json<->unknown, null<->undefined)
 * e a forma das queries geradas (where/orderBy/upsert por chave composta).
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { createPrismaRepositories } from "../repos";

type AnyRow = Record<string, unknown>;

/** Stub de delegate Prisma: registra chamadas e devolve linhas pré-configuradas. */
function delegateStub(row: AnyRow | null = null, rows: AnyRow[] = []) {
  return {
    findFirst: vi.fn(async (_args?: unknown) => row),
    findUnique: vi.fn(async (_args?: unknown) => row),
    findMany: vi.fn(async (_args?: unknown) => rows),
    create: vi.fn(async (args: { data: AnyRow }) => args.data),
    update: vi.fn(async (args: { data: AnyRow }) => args.data),
    upsert: vi.fn(async (args: { create: AnyRow }) => args.create),
  };
}

const dbPayableRow: AnyRow = {
  id: "pay_1",
  companyId: "co_demo",
  supplierId: "sup_1",
  documentId: null,
  description: "Compra de grãos",
  issueDate: new Date("2026-03-01T00:00:00Z"),
  dueDate: new Date("2026-03-10T00:00:00Z"),
  amountCents: 1234567n,
  paidCents: 0n,
  currency: "BRL",
  status: "open",
  categoryId: null,
  costCenterId: null,
  supplierCategory: "Material de Escritório",
  costClassification: "fixed",
  installmentNumber: 1,
  installmentCount: 1,
  originKey: "sup_1|NF-1|1",
  notes: null,
  canceledAt: null,
  createdBy: "usr_ana",
  createdAt: new Date("2026-03-01T12:34:56.000Z"),
  updatedAt: new Date("2026-03-01T12:34:56.000Z"),
};

function makeFakePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  const models = [
    "company",
    "user",
    "membership",
    "customer",
    "supplier",
    "bankAccount",
    "bankTransaction",
    "payable",
    "receivable",
    "payment",
    "receipt",
    "financialDocument",
    "category",
    "costCenter",
    "chartAccount",
    "budget",
    "budgetLine",
    "approval",
    "reconciliationMatch",
    "eventRecord",
    "alert",
    "skillExecution",
    "auditRecord",
    "invoice",
    "collectionMessage",
    "accountingEntry",
    "flowRun",
    "idempotencyRecord",
  ] as const;
  const fake: Record<string, unknown> = {};
  for (const m of models) fake[m] = delegateStub();
  Object.assign(fake, overrides);
  return fake;
}

const asClient = (fake: Record<string, unknown>): PrismaClient =>
  fake as unknown as PrismaClient;

describe("createPrismaRepositories — bundle", () => {
  it("expõe todos os repositórios do contrato Repositories", () => {
    const repos = createPrismaRepositories(asClient(makeFakePrisma()));
    const expectedKeys = [
      "companies",
      "users",
      "memberships",
      "customers",
      "suppliers",
      "bankAccounts",
      "bankTransactions",
      "payables",
      "receivables",
      "payments",
      "receipts",
      "documents",
      "categories",
      "costCenters",
      "chartAccounts",
      "budgets",
      "budgetLines",
      "approvals",
      "reconciliations",
      "alerts",
      "events",
      "skillExecutions",
      "audit",
      "invoices",
      "collectionMessages",
      "accountingEntries",
      "flowRuns",
      "idempotency",
    ];
    for (const key of expectedKeys) {
      expect(repos, `repositório ausente: ${key}`).toHaveProperty(key);
    }
  });

  it("auditoria é append-only: não expõe update nem delete", () => {
    const repos = createPrismaRepositories(asClient(makeFakePrisma()));
    const audit = repos.audit as unknown as Record<string, unknown>;
    expect(audit.update).toBeUndefined();
    expect(audit.delete).toBeUndefined();
    expect(typeof audit.append).toBe("function");
    expect(typeof audit.last).toBe("function");
    expect(typeof audit.list).toBe("function");
  });
});

describe("conversões banco -> domínio", () => {
  it("payable: BigInt->centavos, @db.Date->ISODate, null->undefined, DateTime->ISO", async () => {
    const payable = delegateStub(dbPayableRow);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ payable })));

    const found = await repos.payables.getById("co_demo", "pay_1");
    expect(found).not.toBeNull();
    expect(found?.amountCents).toBe(1234567);
    expect(typeof found?.amountCents).toBe("number");
    expect(found?.paidCents).toBe(0);
    expect(found?.issueDate).toBe("2026-03-01");
    expect(found?.dueDate).toBe("2026-03-10");
    expect(found?.documentId).toBeUndefined();
    expect(found?.notes).toBeUndefined();
    expect(found?.canceledAt).toBeUndefined();
    expect(found?.supplierCategory).toBe("Material de Escritório");
    expect(found?.costClassification).toBe("fixed");
    expect(found?.createdAt).toBe("2026-03-01T12:34:56.000Z");
    expect(payable.findFirst).toHaveBeenCalledWith({
      where: { id: "pay_1", companyId: "co_demo" },
    });
  });

  it("membership: approvalLimitCents BigInt|null <-> number|null (null preservado)", async () => {
    const membership = delegateStub(null, [
      { id: "mem_1", userId: "u1", companyId: "co_demo", role: "admin", approvalLimitCents: null },
      {
        id: "mem_2",
        userId: "u2",
        companyId: "co_demo",
        role: "approver",
        approvalLimitCents: 500000n,
      },
    ]);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ membership })));
    const list = await repos.memberships.listByCompany("co_demo");
    expect(list[0]?.approvalLimitCents).toBeNull();
    expect(list[1]?.approvalLimitCents).toBe(500000);
  });

  it("invoice: nfeMockJson null -> undefined; objeto Json -> nfeMock tipado", async () => {
    const nfe = { number: "123", accessKey: "abc", issuedAt: "2026-01-01T00:00:00Z", provider: "mock" };
    const baseRow: AnyRow = {
      id: "inv_1",
      companyId: "co_demo",
      customerId: "cus_1",
      saleRef: null,
      description: "Venda",
      totalCents: 10000n,
      issueDate: null,
      status: "draft",
      nfeMockJson: null,
      createdBy: "usr_ana",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const invoice = delegateStub(baseRow);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ invoice })));
    const draft = await repos.invoices.getById("co_demo", "inv_1");
    expect(draft?.nfeMock).toBeUndefined();
    expect(draft?.issueDate).toBeUndefined();

    const invoice2 = delegateStub({ ...baseRow, nfeMockJson: nfe, issueDate: new Date("2026-01-02T00:00:00Z"), status: "issued" });
    const repos2 = createPrismaRepositories(asClient(makeFakePrisma({ invoice: invoice2 })));
    const issued = await repos2.invoices.getById("co_demo", "inv_1");
    expect(issued?.nfeMock).toEqual(nfe);
    expect(issued?.issueDate).toBe("2026-01-02");
  });

  it("flowRun: resultsJson Json -> unknown[] (array preservado)", async () => {
    const flowRun = delegateStub({
      id: "fr_1",
      companyId: "co_demo",
      flow: "pagamento",
      status: "completed",
      cursor: 2,
      payloadJson: { a: 1 },
      resultsJson: [{ status: "success" }, { status: "warning" }],
      approvalId: null,
      idempotencyKey: "k1",
      correlationId: "corr_1",
      requestedBy: "usr_ana",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ flowRun })));
    const run = await repos.flowRuns.getById("co_demo", "fr_1");
    expect(run?.payload).toEqual({ a: 1 });
    expect(run?.results).toHaveLength(2);
    expect(run?.approvalId).toBeUndefined();
  });
});

describe("conversões domínio -> banco", () => {
  it("payable.create envia BigInt, Date UTC e null nos opcionais ausentes", async () => {
    const payable = delegateStub(dbPayableRow);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ payable })));

    await repos.payables.create({
      id: "pay_1",
      companyId: "co_demo",
      supplierId: "sup_1",
      description: "Compra de grãos",
      issueDate: "2026-03-01",
      dueDate: "2026-03-10",
      amountCents: 1234567,
      paidCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "sup_1|NF-1|1",
      createdBy: "usr_ana",
      createdAt: "2026-03-01T12:34:56.000Z",
      updatedAt: "2026-03-01T12:34:56.000Z",
    });

    const callArg = payable.create.mock.calls[0]?.[0] as { data: AnyRow };
    expect(callArg.data.amountCents).toBe(1234567n);
    expect(typeof callArg.data.amountCents).toBe("bigint");
    expect(callArg.data.issueDate).toBeInstanceOf(Date);
    expect((callArg.data.issueDate as Date).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(callArg.data.documentId).toBeNull();
    expect(callArg.data.notes).toBeNull();
    expect(callArg.data.canceledAt).toBeNull();
    // opcionais ausentes viram null no banco
    expect(callArg.data.supplierCategory).toBeNull();
    expect(callArg.data.costClassification).toBeNull();
  });

  it("update escopa o where por { id, companyId }", async () => {
    const payable = delegateStub(dbPayableRow);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ payable })));
    const entity = (await repos.payables.getById("co_demo", "pay_1"))!;
    await repos.payables.update({ ...entity, status: "paid", paidCents: entity.amountCents });
    const callArg = payable.update.mock.calls[0]?.[0] as { where: AnyRow; data: AnyRow };
    expect(callArg.where).toEqual({ id: "pay_1", companyId: "co_demo" });
    expect(callArg.data.paidCents).toBe(1234567n);
    expect(callArg.data.status).toBe("paid");
  });

  it("findByOriginKey usa a chave única composta companyId_originKey", async () => {
    const payable = delegateStub(dbPayableRow);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ payable })));
    await repos.payables.findByOriginKey("co_demo", "sup_1|NF-1|1");
    expect(payable.findUnique).toHaveBeenCalledWith({
      where: { companyId_originKey: { companyId: "co_demo", originKey: "sup_1|NF-1|1" } },
    });
  });

  it("idempotency.save faz UPSERT por (companyId, key) preservando o id no update", async () => {
    const idempotencyRecord = delegateStub();
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ idempotencyRecord })));
    await repos.idempotency.save({
      id: "idem_1",
      companyId: "co_demo",
      key: "flow:pagamento:x",
      requestHash: "h1",
      result: { ok: true },
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    const callArg = idempotencyRecord.upsert.mock.calls[0]?.[0] as {
      where: AnyRow;
      create: AnyRow;
      update: AnyRow;
    };
    expect(callArg.where).toEqual({
      companyId_key: { companyId: "co_demo", key: "flow:pagamento:x" },
    });
    expect(callArg.create.id).toBe("idem_1");
    // update não reatribui id: o registro existente mantém sua identidade
    expect(callArg.update.id).toBeUndefined();
    expect(callArg.update.requestHash).toBe("h1");
  });

  it("audit.last ordena por seq desc; append cria registro imutável", async () => {
    const auditRecord = delegateStub({
      id: "aud_9",
      companyId: "co_demo",
      seq: 9,
      actorType: "system",
      actorId: "system",
      action: "seed",
      entityType: "Company",
      entityId: "co_demo",
      beforeJson: null,
      afterJson: { active: true },
      correlationId: null,
      timestamp: new Date("2026-05-01T00:00:00Z"),
      prevHash: "0",
      hash: "abc",
    });
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ auditRecord })));
    const last = await repos.audit.last("co_demo");
    expect(auditRecord.findFirst).toHaveBeenCalledWith({
      where: { companyId: "co_demo" },
      orderBy: { seq: "desc" },
    });
    expect(last?.seq).toBe(9);
    expect(last?.before).toBeUndefined();
    expect(last?.after).toEqual({ active: true });
    expect(last?.correlationId).toBeUndefined();
  });

  it("listDueBetween converte o intervalo ISODate para Date UTC em gte/lte", async () => {
    const payable = delegateStub(null, []);
    const repos = createPrismaRepositories(asClient(makeFakePrisma({ payable })));
    await repos.payables.listDueBetween("co_demo", "2026-03-01", "2026-03-31");
    const callArg = payable.findMany.mock.calls[0]?.[0] as {
      where: { companyId: string; dueDate: { gte: Date; lte: Date } };
    };
    expect(callArg.where.dueDate.gte.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(callArg.where.dueDate.lte.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });
});
