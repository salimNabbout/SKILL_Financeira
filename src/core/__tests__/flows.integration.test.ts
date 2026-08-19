/**
 * Teste de integração ponta-a-ponta: orquestrador + skills REAIS.
 * Cobre os critérios de aceite: fluxo integrado com 4+ skills, aprovação humana,
 * idempotência (mesma requisição não duplica lançamentos) e trilha de auditoria.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import { buildRegistry } from "@/skills";
import { verifyChain } from "../audit";
import type { Orchestrator, OrchestratorResponse } from "../orchestrator/orchestrator";

let env: TestEnv;
let orch: Orchestrator;

const NOW = "2026-08-18T15:00:00Z"; // hoje em SP: 2026-08-18

beforeEach(async () => {
  env = createTestEnv(NOW);
  orch = env.orchestrator(buildRegistry());
  const now = env.clock.now().toISOString();

  await env.repos.suppliers.create({
    id: "sup_1",
    companyId: env.company.id,
    name: "Torrefação Boa Vista",
    document: "22.333.444/0001-55",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await env.repos.customers.create({
    id: "cus_1",
    companyId: env.company.id,
    name: "Cafeteria Lua",
    document: "33.444.555/0001-66",
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
    openingBalanceDate: "2026-08-01",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await env.repos.categories.create({
    id: "cat_insumos",
    companyId: env.company.id,
    name: "Insumos e mercadorias",
    kind: "expense",
    dreGroup: "custos",
    active: true,
  });
});

describe("fluxo integrado: nota de fornecedor (4 skills)", () => {
  const payload = {
    supplierId: "sup_1",
    description: "NF 8841 — café verde",
    issueDate: "2026-08-10",
    dueDate: "2026-09-10",
    amountCents: 500_000,
    categoryId: "cat_insumos",
  };

  it("executa AP → Controles → Tesouraria → Orçamento e consolida", async () => {
    const res = await orch.execute({
      flow: "supplier_invoice_intake",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload,
    });

    expect(res.status).toBe("completed");
    const stepIds = res.results.map((r) => r.stepId);
    expect(stepIds).toEqual(["ap_create", "controls_validate", "treasury_refresh", "budget_check"]);

    const skillsUsed = new Set(res.results.map((r) => r.result.skill));
    expect(skillsUsed.size).toBeGreaterThanOrEqual(4);

    const payables = await env.repos.payables.listAll(env.company.id);
    expect(payables).toHaveLength(1);
    expect(payables[0].amountCents).toBe(500_000);

    // Consolidação expõe fontes de dados usadas
    expect(res.consolidated.data_sources.length).toBeGreaterThan(0);
  });

  it("mesma requisição não gera lançamentos duplicados (idempotência dupla)", async () => {
    const req = {
      flow: "supplier_invoice_intake",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload,
      idempotencyKey: "nf-8841",
    };
    const first = await orch.execute(req);
    const second = await orch.execute(req);

    expect(second.idempotent_replay).toBe(true);
    expect(second.flowRunId).toBe(first.flowRunId);
    expect(await env.repos.payables.listAll(env.company.id)).toHaveLength(1);

    // Sem chave explícita, payload idêntico também não duplica (hash do payload)
    await orch.execute({ ...req, idempotencyKey: undefined });
    expect(await env.repos.payables.listAll(env.company.id)).toHaveLength(1);
  });
});

describe("fluxo integrado: pagamento com aprovação humana (4 skills)", () => {
  async function createPayable(): Promise<string> {
    const res = await orch.execute({
      flow: "supplier_invoice_intake",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {
        supplierId: "sup_1",
        description: "NF 9001 — embalagens",
        issueDate: "2026-08-01",
        dueDate: "2026-08-25",
        amountCents: 120_000, // R$ 1.200 — alçada de approver
        categoryId: "cat_insumos",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (res.results[0].result.data as any).payables[0].id;
  }

  it("suspende, aprova com segregação, executa (mock) e prepara contabilidade", async () => {
    const payableId = await createPayable();

    const res = await orch.execute({
      flow: "schedule_payment",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {
        payableId,
        bankAccountId: "ba_1",
        scheduledDate: "2026-08-20",
        method: "pix",
      },
    });

    expect(res.status).toBe("awaiting_approval");
    expect(res.approval?.requiredRole).toBe("approver");

    // Solicitante não aprova a própria solicitação
    await expect(
      orch.decideApproval({
        companyId: env.company.id,
        approvalId: res.approval!.id,
        decision: "approved",
        actor: env.actorFor("analyst"),
      })
    ).rejects.toThrow();

    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("approver"),
      justification: "dentro da política",
    })) as OrchestratorResponse;

    expect(resumed.status).toBe("completed");

    const payments = await env.repos.payments.listByStatus(env.company.id, ["executed"]);
    expect(payments).toHaveLength(1);
    expect(payments[0].executedBy).toBe("usr_approver");
    expect(payments[0].approvalId).toBeTruthy();

    const payable = await env.repos.payables.getById(env.company.id, payableId);
    expect(payable?.status).toBe("paid");

    // Lançamento contábil preparado pelo passo de integração contábil
    const entries = await env.repos.accountingEntries.listAll(env.company.id);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.sourceType === "payment" && e.sourceId === payments[0].id)).toBe(
      true
    );

    // Trilha de auditoria íntegra cobrindo o ciclo inteiro
    const audit = await env.repos.audit.list(env.company.id);
    expect(verifyChain(audit).valid).toBe(true);
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("flow.started");
    expect(actions).toContain("approval.requested");
    expect(actions).toContain("approval.approved");
    expect(actions).toContain("flow.completed");
  });

  it("não permite burlar a alçada fracionando o pagamento de um título grande", async () => {
    // Título de R$ 60.000 (acima de R$ 50.000 → exige admin).
    const res0 = await orch.execute({
      flow: "supplier_invoice_intake",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {
        supplierId: "sup_1",
        description: "NF 9002 — máquina",
        issueDate: "2026-08-01",
        dueDate: "2026-08-25",
        amountCents: 6_000_000,
        categoryId: "cat_insumos",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bigPayableId = (res0.results[0].result.data as any).payables[0].id;

    // Agenda apenas R$ 4.999 (abaixo da faixa de approver) — a alçada exigida
    // deve refletir o TAMANHO DO TÍTULO (admin), não o do pagamento fracionado.
    const res = await orch.execute({
      flow: "schedule_payment",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {
        payableId: bigPayableId,
        bankAccountId: "ba_1",
        scheduledDate: "2026-08-20",
        method: "pix",
        amountCents: 499_900,
      },
    });

    expect(res.status).toBe("awaiting_approval");
    expect(res.approval?.requiredRole).toBe("admin");
  });

  it("rejeição cancela o pagamento e o título volta a aberto", async () => {
    const payableId = await createPayable();
    const res = await orch.execute({
      flow: "schedule_payment",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { payableId, bankAccountId: "ba_1", scheduledDate: "2026-08-20", method: "ted" },
    });

    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "rejected",
      actor: env.actorFor("approver"),
      justification: "fora de política",
    })) as OrchestratorResponse;

    expect(resumed.status).toBe("rejected");
    expect(await env.repos.payments.listByStatus(env.company.id, ["executed"])).toHaveLength(0);
    const payable = await env.repos.payables.getById(env.company.id, payableId);
    expect(payable?.status).toBe("open");
  });
});

describe("fluxo integrado: extrato bancário e conciliação automática", () => {
  it("importa OFX, deduplica e concilia crédito exato com baixa automática", async () => {
    const now = env.clock.now().toISOString();
    await env.repos.receivables.create({
      id: "ar_1",
      companyId: env.company.id,
      customerId: "cus_1",
      description: "Pedido 77 — Cafeteria Lua",
      issueDate: "2026-07-15",
      dueDate: "2026-08-15",
      amountCents: 250_000,
      receivedCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "cus_1:pedido77:1/1",
      createdBy: "usr_analyst",
      createdAt: now,
      updatedAt: now,
    });

    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260815120000[-3:BRT]
<TRNAMT>2500.00
<FITID>TX-001
<MEMO>PIX RECEBIDO CAFETERIA LUA PED 77
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260816
<TRNAMT>-89.90
<FITID>TX-002
<MEMO>TARIFA PACOTE SERVICOS
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    const res = await orch.execute({
      flow: "bank_statement_import",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { bankAccountId: "ba_1", format: "ofx", content: ofx },
    });

    expect(res.status).toBe("completed");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importData = res.results.find((r) => r.stepId === "import")!.result.data as any;
    expect(importData.imported).toBe(2);

    // Crédito exato (valor+data+nome do cliente) → conciliado automaticamente com baixa
    const receivable = await env.repos.receivables.getById(env.company.id, "ar_1");
    expect(receivable?.status).toBe("received");
    expect(receivable?.receivedCents).toBe(250_000);
    const receipts = await env.repos.receipts.listByReceivable(env.company.id, "ar_1");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].registeredBy).toBe("system");

    // Reimportar o MESMO arquivo não duplica transações (dedupe por FITID)
    const again = await orch.execute({
      flow: "bank_statement_import",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: { bankAccountId: "ba_1", format: "ofx", content: ofx },
      idempotencyKey: "reimport-1",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const againData = again.results.find((r) => r.stepId === "import")!.result.data as any;
    expect(againData.imported).toBe(0);
    expect(againData.duplicates).toBe(2);
    expect(await env.repos.bankTransactions.listByAccount(env.company.id, "ba_1")).toHaveLength(2);
  });
});

describe("fluxo integrado: régua de cobrança com aprovação", () => {
  it("rascunha mensagens, exige aprovação e envia (mock) após aprovado", async () => {
    const now = env.clock.now().toISOString();
    await env.repos.receivables.create({
      id: "ar_venc",
      companyId: env.company.id,
      customerId: "cus_1",
      description: "Pedido 42",
      issueDate: "2026-07-01",
      dueDate: "2026-08-05", // 13 dias de atraso em 18/08
      amountCents: 300_000,
      receivedCents: 0,
      currency: "BRL",
      status: "open",
      installmentNumber: 1,
      installmentCount: 1,
      originKey: "cus_1:pedido42:1/1",
      createdBy: "usr_analyst",
      createdAt: now,
      updatedAt: now,
    });

    const res = await orch.execute({
      flow: "dunning_run",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {},
    });

    expect(res.status).toBe("awaiting_approval");
    const drafted = await env.repos.collectionMessages.listByStatus(env.company.id, [
      "awaiting_approval",
    ]);
    expect(drafted.length).toBeGreaterThanOrEqual(1);
    expect(drafted[0].body).toContain("Cafeteria Lua"); // template renderizado

    const resumed = (await orch.decideApproval({
      companyId: env.company.id,
      approvalId: res.approval!.id,
      decision: "approved",
      actor: env.actorFor("manager"),
      justification: "textos revisados",
    })) as OrchestratorResponse;

    expect(resumed.status).toBe("completed");
    const sent = await env.repos.collectionMessages.listByStatus(env.company.id, ["sent"]);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0].sentAt).toBeTruthy(); // envio mock registrado
  });
});

describe("fluxos de relatório", () => {
  it("daily_summary e monthly_close executam e consolidam", async () => {
    const daily = await orch.execute({
      flow: "daily_summary",
      companyId: env.company.id,
      actor: env.actorFor("manager"),
      payload: {},
    });
    expect(daily.status).toBe("completed");
    expect(daily.results.find((r) => r.stepId === "report")?.result.status).not.toBe("error");

    const close = await orch.execute({
      flow: "monthly_close",
      companyId: env.company.id,
      actor: env.actorFor("manager"),
      payload: { period: "2026-08" },
    });
    expect(close.status).toBe("completed");
  });
});
