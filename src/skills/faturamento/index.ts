/**
 * Skill: Faturamento
 * Geração e acompanhamento de cobranças; ciclo venda → faturamento → recebimento;
 * vendas ainda não faturadas.
 *
 * A integração NF-e/NFS-e é CONCEITUAL (mock explícito): nenhum documento fiscal
 * real é emitido; número e chave de acesso são fictícios e determinísticos.
 */

import { z } from "zod";
import { persistAlert } from "@/core/alerts";
import type { ISODate } from "@/core/dates";
import { formatBRL, receiptIsActive } from "@/core/money";
import type { Invoice, Receivable } from "@/core/entities";
import { NotFoundError } from "@/core/errors";
import { errorResult, makeResult, type SkillContext, type SkillDefinition } from "@/core/skill";
import type { PendingItem, SkillAlert, SkillResult } from "@/core/types";

const SKILL_NAME = "faturamento" as const;

const NFE_MOCK_ASSUMPTION =
  "Emissão de NF-e/NFS-e é SIMULADA (mock): nenhum documento fiscal real foi emitido junto à SEFAZ; número e chave de acesso são fictícios e determinísticos.";

// ---------------------------------------------------------------------------
// Entrada — uma variante por ação
// ---------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data deve estar no formato YYYY-MM-DD");

const centsSchema = z.number().int().positive();

const createInvoiceSchema = z.object({
  action: z.literal("create_invoice"),
  customerId: z.string().min(1),
  description: z.string().min(1),
  totalCents: centsSchema,
  saleRef: z.string().min(1).optional(),
  issue: z.boolean().optional(),
  // Aceitos e IGNORADOS aqui: o fluxo customer_invoice_intake repassa o payload
  // completo; parcelas/método são tratados pela skill contas_a_receber.
  installments: z
    .array(z.object({ dueDate: isoDateSchema, amountCents: centsSchema }))
    .optional(),
  method: z.enum(["pix", "boleto", "card", "transfer", "cash"]).optional(),
});

const issueInvoiceSchema = z.object({
  action: z.literal("issue_invoice"),
  invoiceId: z.string().min(1),
});

const cancelInvoiceSchema = z.object({
  action: z.literal("cancel_invoice"),
  invoiceId: z.string().min(1),
  reason: z.string().min(1),
});

const billingStatusSchema = z.object({
  action: z.literal("billing_status"),
});

export const faturamentoInputSchema = z.discriminatedUnion("action", [
  createInvoiceSchema,
  issueInvoiceSchema,
  cancelInvoiceSchema,
  billingStatusSchema,
]);

export type FaturamentoInput = z.infer<typeof faturamentoInputSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;
export type BillingStatusInput = z.infer<typeof billingStatusSchema>;

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export interface InvoiceData {
  invoice: Invoice;
}

export interface CancelInvoiceData {
  invoice: Invoice;
  canceledReceivables: Receivable[];
}

export interface DraftSummary {
  invoiceId: string;
  customerId: string;
  description: string;
  totalCents: number;
  createdAt: string;
}

export interface IssuedUnbilledSummary {
  invoiceId: string;
  customerId: string;
  description: string;
  totalCents: number;
  issueDate?: ISODate;
}

export interface BillingCycleItem {
  invoiceId: string;
  totalCents: number;
  receivedCents: number;
  receivablesCount: number;
  status: "open" | "partially_received" | "received";
  receivedPercent: number;
}

export interface BillingStatusData {
  drafts: DraftSummary[];
  issuedUnbilled: IssuedUnbilledSummary[];
  cycle: BillingCycleItem[];
  formula: string;
  period: { asOf: ISODate };
}

export type FaturamentoData = InvoiceData | CancelInvoiceData | BillingStatusData | null;

// ---------------------------------------------------------------------------
// Helpers do mock de NF-e
// ---------------------------------------------------------------------------

/** Próximo sequencial de NF-e por empresa (baseado nos números já emitidos). */
async function nextNfeSequential(ctx: SkillContext): Promise<number> {
  const invoices = await ctx.repos.invoices.listAll(ctx.companyId);
  let max = 0;
  for (const inv of invoices) {
    const match = inv.nfeMock?.number.match(/^NFE-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Emite uma fatura draft via porta FiscalProvider (mock no MVP — nenhuma
 * comunicação com SEFAZ/prefeitura): muda status, grava os dados fiscais
 * devolvidos pela porta, audita e publica.
 */
async function performIssue(ctx: SkillContext, invoice: Invoice): Promise<Invoice> {
  const now = ctx.clock.now().toISOString();
  const before = { ...invoice };
  const company = await ctx.repos.companies.getById(ctx.companyId);
  if (!company) throw new NotFoundError("Empresa", ctx.companyId);

  const fiscal = await ctx.integrations.fiscal.issueInvoice({
    invoice: {
      id: invoice.id,
      description: invoice.description,
      totalCents: invoice.totalCents,
      saleRef: invoice.saleRef,
    },
    company: { id: company.id, cnpj: company.cnpj, name: company.name },
    sequential: await nextNfeSequential(ctx),
    issuedAtIso: now,
  });

  invoice.status = "issued";
  invoice.issueDate = ctx.today();
  invoice.nfeMock = {
    number: fiscal.number,
    accessKey: fiscal.accessKey,
    issuedAt: fiscal.issuedAt,
    provider: fiscal.provider,
  };
  invoice.updatedAt = now;
  await ctx.repos.invoices.update(invoice);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "invoice.issued",
    entityType: "invoice",
    entityId: invoice.id,
    before,
    after: invoice,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "invoice.issued",
    payload: {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      totalCents: invoice.totalCents,
      issueDate: invoice.issueDate,
      nfeNumber: invoice.nfeMock.number,
      nfeAccessKey: invoice.nfeMock.accessKey,
      provider: invoice.nfeMock.provider,
    },
    source: SKILL_NAME,
    correlationId: ctx.correlationId,
  });
  return invoice;
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function createInvoice(
  ctx: SkillContext,
  input: CreateInvoiceInput
): Promise<SkillResult<FaturamentoData>> {
  const customer = await ctx.repos.customers.getById(ctx.companyId, input.customerId);
  if (!customer) {
    return errorResult(SKILL_NAME, ctx, "customer_not_found", `Cliente não encontrado: ${input.customerId}`);
  }
  if (!customer.active) {
    return errorResult(SKILL_NAME, ctx, "customer_inactive", `Cliente inativo: ${customer.name}. Reative o cadastro antes de faturar.`);
  }

  const assumptions: string[] = [];
  const issue = input.issue ?? false;

  if (input.installments && input.installments.length > 0) {
    assumptions.push(
      "Parcelas informadas são tratadas pela skill de Contas a Receber (create_from_invoice); ignoradas na emissão da fatura."
    );
  }

  // Idempotência por saleRef: mesma referência de venda não gera fatura duplicada.
  if (input.saleRef) {
    const existing = (await ctx.repos.invoices.listAll(ctx.companyId)).find(
      (inv) => inv.saleRef === input.saleRef && inv.status !== "canceled"
    );
    if (existing) {
      assumptions.push(
        `Já existe fatura não cancelada para a referência de venda "${input.saleRef}" (${existing.id}); o registro existente foi retornado sem duplicação (idempotência).`
      );
      let invoice = existing;
      if (issue && invoice.status === "draft") {
        invoice = await performIssue(ctx, invoice);
        assumptions.push(NFE_MOCK_ASSUMPTION);
      }
      return makeResult(SKILL_NAME, ctx, { invoice } as FaturamentoData, {
        assumptions,
        dataSources: ["invoices", "customers"],
      });
    }
  }

  const now = ctx.clock.now().toISOString();
  let invoice: Invoice = {
    id: ctx.ids.next("inv"),
    companyId: ctx.companyId,
    customerId: input.customerId,
    saleRef: input.saleRef,
    description: input.description,
    totalCents: input.totalCents,
    status: "draft",
    createdBy: ctx.actor.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.invoices.create(invoice);

  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "invoice.created",
    entityType: "invoice",
    entityId: invoice.id,
    after: invoice,
    correlationId: ctx.correlationId,
  });
  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "invoice.created",
    payload: {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      totalCents: invoice.totalCents,
      saleRef: invoice.saleRef,
      status: invoice.status,
    },
    source: SKILL_NAME,
    correlationId: ctx.correlationId,
  });

  if (issue) {
    invoice = await performIssue(ctx, invoice);
    assumptions.push(NFE_MOCK_ASSUMPTION);
  }

  return makeResult(SKILL_NAME, ctx, { invoice } as FaturamentoData, {
    assumptions,
    dataSources: ["invoices", "customers"],
  });
}

async function issueInvoice(
  ctx: SkillContext,
  input: IssueInvoiceInput
): Promise<SkillResult<FaturamentoData>> {
  const invoice = await ctx.repos.invoices.getById(ctx.companyId, input.invoiceId);
  if (!invoice) {
    return errorResult(SKILL_NAME, ctx, "invoice_not_found", `Fatura não encontrada: ${input.invoiceId}`);
  }
  if (invoice.status === "canceled") {
    return errorResult(SKILL_NAME, ctx, "invoice_canceled", `A fatura ${invoice.id} está cancelada e não pode ser emitida.`);
  }
  if (invoice.status === "issued") {
    return makeResult(SKILL_NAME, ctx, { invoice } as FaturamentoData, {
      assumptions: [
        `A fatura ${invoice.id} já estava emitida (NF-e mock ${invoice.nfeMock?.number ?? "?"}); nenhuma nova emissão foi feita (idempotência).`,
      ],
      dataSources: ["invoices"],
    });
  }

  const issued = await performIssue(ctx, invoice);
  return makeResult(SKILL_NAME, ctx, { invoice: issued } as FaturamentoData, {
    assumptions: [NFE_MOCK_ASSUMPTION],
    dataSources: ["invoices"],
  });
}

async function cancelInvoice(
  ctx: SkillContext,
  input: CancelInvoiceInput
): Promise<SkillResult<FaturamentoData>> {
  const invoice = await ctx.repos.invoices.getById(ctx.companyId, input.invoiceId);
  if (!invoice) {
    return errorResult(SKILL_NAME, ctx, "invoice_not_found", `Fatura não encontrada: ${input.invoiceId}`);
  }
  if (invoice.status === "canceled") {
    return makeResult(
      SKILL_NAME,
      ctx,
      { invoice, canceledReceivables: [] } as FaturamentoData,
      {
        assumptions: [`A fatura ${invoice.id} já estava cancelada; nenhuma ação adicional (idempotência).`],
        dataSources: ["invoices"],
      }
    );
  }

  const receivables = (await ctx.repos.receivables.listAll(ctx.companyId)).filter(
    (r) => r.invoiceId === invoice.id
  );

  // Bloqueio: fatura com qualquer recebimento registrado não pode ser cancelada.
  for (const r of receivables) {
    const receipts = (
      await ctx.repos.receipts.listByReceivable(ctx.companyId, r.id)
    ).filter(receiptIsActive);
    if (receipts.length > 0 || r.receivedCents > 0) {
      return errorResult(
        SKILL_NAME,
        ctx,
        "invoice_has_receipts",
        `Não é possível cancelar a fatura ${invoice.id}: o título ${r.id} já possui recebimento registrado (${formatBRL(r.receivedCents)}). Estorne o recebimento antes de cancelar.`
      );
    }
  }

  const now = ctx.clock.now().toISOString();
  const before = { ...invoice };
  invoice.status = "canceled";
  invoice.updatedAt = now;
  await ctx.repos.invoices.update(invoice);
  await ctx.audit.record(ctx.companyId, {
    actor: ctx.actor,
    action: "invoice.canceled",
    entityType: "invoice",
    entityId: invoice.id,
    before,
    after: { ...invoice, cancelReason: input.reason },
    correlationId: ctx.correlationId,
  });

  // Cancela também os títulos em aberto vinculados à fatura (com auditoria).
  const canceledReceivables: Receivable[] = [];
  for (const r of receivables) {
    if (r.status !== "open" && r.status !== "partially_received") continue;
    const rBefore = { ...r };
    r.status = "canceled";
    r.canceledAt = now;
    r.updatedAt = now;
    await ctx.repos.receivables.update(r);
    await ctx.audit.record(ctx.companyId, {
      actor: ctx.actor,
      action: "receivable.canceled",
      entityType: "receivable",
      entityId: r.id,
      before: rBefore,
      after: { ...r, cancelReason: `Cancelamento da fatura ${invoice.id}: ${input.reason}` },
      correlationId: ctx.correlationId,
    });
    canceledReceivables.push(r);
  }

  await ctx.events.publish({
    companyId: ctx.companyId,
    type: "invoice.canceled",
    payload: {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      totalCents: invoice.totalCents,
      reason: input.reason,
      canceledReceivableIds: canceledReceivables.map((r) => r.id),
    },
    source: SKILL_NAME,
    correlationId: ctx.correlationId,
  });

  return makeResult(SKILL_NAME, ctx, { invoice, canceledReceivables } as FaturamentoData, {
    dataSources: ["invoices", "receivables", "receipts"],
  });
}

async function billingStatus(ctx: SkillContext): Promise<SkillResult<FaturamentoData>> {
  const invoices = await ctx.repos.invoices.listAll(ctx.companyId);
  const receivables = await ctx.repos.receivables.listAll(ctx.companyId);

  const activeByInvoice = new Map<string, Receivable[]>();
  for (const r of receivables) {
    if (!r.invoiceId || r.status === "canceled") continue;
    const list = activeByInvoice.get(r.invoiceId) ?? [];
    list.push(r);
    activeByInvoice.set(r.invoiceId, list);
  }

  const drafts: DraftSummary[] = invoices
    .filter((inv) => inv.status === "draft")
    .map((inv) => ({
      invoiceId: inv.id,
      customerId: inv.customerId,
      description: inv.description,
      totalCents: inv.totalCents,
      createdAt: inv.createdAt,
    }));

  const pendingItems: PendingItem[] = drafts.map((d) => ({
    code: "venda_nao_faturada",
    description: `Venda registrada e ainda não faturada: "${d.description}" (${formatBRL(d.totalCents)}).`,
    entityType: "invoice",
    entityId: d.invoiceId,
    suggestedAction: "Emitir a fatura (issue_invoice) para gerar a NF-e (mock) e os títulos a receber.",
  }));

  const issued = invoices.filter((inv) => inv.status === "issued");
  const issuedUnbilled: IssuedUnbilledSummary[] = issued
    .filter((inv) => (activeByInvoice.get(inv.id)?.length ?? 0) === 0)
    .map((inv) => ({
      invoiceId: inv.id,
      customerId: inv.customerId,
      description: inv.description,
      totalCents: inv.totalCents,
      issueDate: inv.issueDate,
    }));

  const alerts: SkillAlert[] = [];
  if (issuedUnbilled.length > 0) {
    const openAlerts = await ctx.repos.alerts.listOpen(ctx.companyId);
    for (const item of issuedUnbilled) {
      const message = `Fatura ${item.invoiceId} emitida (${formatBRL(item.totalCents)}) sem títulos a receber vinculados — inconsistência no ciclo de faturamento.`;
      alerts.push({
        severity: "warning",
        code: "invoice_sem_titulos",
        message,
        entityType: "invoice",
        entityId: item.invoiceId,
      });
      // O dedupe (code + entityId entre os abertos) agora vive no helper.
      await persistAlert(
        ctx,
        {
          severity: "warning",
          code: "invoice_sem_titulos",
          message,
          entityType: "invoice",
          entityId: item.invoiceId,
        },
        SKILL_NAME
      );
    }
  }

  const cycle: BillingCycleItem[] = issued
    .filter((inv) => (activeByInvoice.get(inv.id)?.length ?? 0) > 0)
    .map((inv) => {
      const rs = activeByInvoice.get(inv.id) ?? [];
      const receivedCents = rs.reduce((acc, r) => acc + r.receivedCents, 0);
      const status: BillingCycleItem["status"] =
        receivedCents >= inv.totalCents ? "received" : receivedCents > 0 ? "partially_received" : "open";
      const receivedPercent =
        inv.totalCents > 0 ? Math.round((receivedCents / inv.totalCents) * 10000) / 100 : 0;
      return {
        invoiceId: inv.id,
        totalCents: inv.totalCents,
        receivedCents,
        receivablesCount: rs.length,
        status,
        receivedPercent,
      };
    });

  const data: BillingStatusData = {
    drafts,
    issuedUnbilled,
    cycle,
    formula: "percentual_recebido = Σ recebido dos títulos da fatura ÷ total da fatura × 100",
    period: { asOf: ctx.today() },
  };

  return makeResult(SKILL_NAME, ctx, data as FaturamentoData, {
    alerts,
    pendingItems,
    dataSources: ["invoices", "receivables"],
  });
}

// ---------------------------------------------------------------------------
// Definição da skill
// ---------------------------------------------------------------------------

export const faturamentoSkill: SkillDefinition<FaturamentoInput, FaturamentoData> = {
  name: SKILL_NAME,
  responsibility:
    "Faturamento: geração e acompanhamento de cobranças; ciclo venda → faturamento → recebimento; emissão NF-e/NFS-e conceitual (mock explícito); vendas ainda não faturadas.",
  objective:
    "Transformar vendas em cobranças rastreáveis: criar e emitir faturas idempotentes por referência de venda, cancelar com regras de segurança e dar visibilidade do ciclo de faturamento.",
  inputSchema: faturamentoInputSchema,
  consumes: [],
  publishes: ["invoice.created", "invoice.issued", "invoice.canceled"],
  dataSources: ["invoices", "customers", "receivables", "receipts"],
  async execute(ctx, input) {
    switch (input.action) {
      case "create_invoice":
        return createInvoice(ctx, input);
      case "issue_invoice":
        return issueInvoice(ctx, input);
      case "cancel_invoice":
        return cancelInvoice(ctx, input);
      case "billing_status":
        return billingStatus(ctx);
    }
  },
};
