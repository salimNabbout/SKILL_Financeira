import { describe, expect, it } from "vitest";
import type {
  BankAccount,
  BankTransaction,
  CashflowManualEntry,
  CashflowMapping,
  Payable,
  Payment,
  Receipt,
  Receivable,
  ReconciliationMatch,
} from "@/core/entities";
import { CASHFLOW_CATEGORY_PLAN } from "../plan";
import { normalizeKey, unifyCashflow, type UnifyInput } from "../unify";

const CO = "co_1";
const TZ = "America/Sao_Paulo";
const NOW = "2026-08-18T15:00:00.000Z";

const account = (id: string): BankAccount => ({
  id, companyId: CO, name: id, bankCode: "341", agency: "0001", accountNumberMasked: "****",
  type: "checking", currency: "BRL", openingBalanceCents: 0, openingBalanceDate: "2026-01-01",
  active: true, createdAt: NOW, updatedAt: NOW,
});
const payable = (over: Partial<Payable> & { id: string }): Payable => ({
  companyId: CO, supplierId: "sup_1", description: "Folha de agosto", issueDate: "2026-08-01",
  dueDate: "2026-08-20", amountCents: 10_000, paidCents: 0, currency: "BRL", status: "open",
  installmentNumber: 1, installmentCount: 1, originKey: `k_${over.id}`, supplierCategory: "Folha",
  createdBy: "usr", createdAt: NOW, updatedAt: NOW, ...over,
});
const payment = (over: Partial<Payment> & { id: string; payableId: string }): Payment => ({
  companyId: CO, bankAccountId: "ba_1", amountCents: 10_000, scheduledDate: "2026-08-18",
  status: "executed", executedAt: "2026-08-18T12:00:00.000Z", requestedBy: "usr",
  createdAt: NOW, updatedAt: NOW, ...over,
});
const receivable = (over: Partial<Receivable> & { id: string }): Receivable => ({
  companyId: CO, customerId: "cus_1", description: "Mensalidade", issueDate: "2026-08-01",
  dueDate: "2026-08-25", amountCents: 20_000, receivedCents: 0, currency: "BRL", status: "open",
  installmentNumber: 1, installmentCount: 1, originKey: `k_${over.id}`, categoryId: "cat_servicos",
  createdBy: "usr", createdAt: NOW, updatedAt: NOW, ...over,
});
const receipt = (over: Partial<Receipt> & { id: string; receivableId: string }): Receipt => ({
  companyId: CO, bankAccountId: "ba_1", amountCents: 20_000, receivedDate: "2026-08-19",
  method: "pix", status: "registered", registeredBy: "usr", createdAt: NOW, ...over,
});
const tx = (over: Partial<BankTransaction> & { id: string; amountCents: number }): BankTransaction => ({
  companyId: CO, bankAccountId: "ba_1", date: "2026-08-18", currency: "BRL",
  description: "PIX ENVIADO", source: "ofx", reconciled: false, createdAt: NOW, ...over,
});
const match = (over: Partial<ReconciliationMatch> & { id: string; bankTransactionId: string; targetType: ReconciliationMatch["targetType"] }): ReconciliationMatch => ({
  companyId: CO, confidence: 1, status: "confirmed", matchedBy: "usr", createdAt: NOW, updatedAt: NOW, ...over,
});
const mapping = (over: Partial<CashflowMapping> & { id: string; source: CashflowMapping["source"]; sourceKey: string; categoryId: string }): CashflowMapping => ({
  companyId: CO, priority: 100, active: true, createdBy: "usr", createdAt: NOW, updatedAt: NOW, version: 1, ...over,
});

const MAPPINGS: CashflowMapping[] = [
  mapping({ id: "m1", source: "categoria_ap", sourceKey: "Folha", categoryId: "folha_salarios" }),
  mapping({ id: "m2", source: "categoria_ar", sourceKey: "cat_servicos", categoryId: "prestacao_servicos" }),
  mapping({ id: "m3", source: "regra_texto", sourceKey: "aluguel", categoryId: "aluguel", priority: 10 }),
  mapping({ id: "m4", source: "plano_contas", sourceKey: "cat_fornec", categoryId: "fornecedores" }),
];

function base(over: Partial<UnifyInput> = {}): UnifyInput {
  return {
    timeZone: TZ,
    payables: [], payments: [], receivables: [], receipts: [],
    bankAccounts: [account("ba_1"), account("ba_2")],
    bankTransactions: [], matches: [], manualEntries: [],
    mappings: MAPPINGS,
    categories: [...CASHFLOW_CATEGORY_PLAN],
    ...over,
  };
}

const soma = (r: ReturnType<typeof unifyCashflow>, f: (e: ReturnType<typeof unifyCashflow>["entries"][number]) => boolean = () => true) =>
  r.entries.filter(f).reduce((acc, e) => acc + (e.kind === "entrada" ? e.amountCents : -e.amountCents), 0);

describe("Fluxo de Caixa — unificação (vw_fc_lancamento)", () => {
  it("título pago E conciliado entra UMA vez: realizado pela conciliação, na data do movimento", () => {
    const r = unifyCashflow(base({
      payables: [payable({ id: "pv1", status: "paid", paidCents: 10_000 })],
      payments: [payment({ id: "pay1", payableId: "pv1" })],
      bankTransactions: [tx({ id: "tx1", amountCents: -10_000, date: "2026-08-19" })],
      matches: [match({ id: "mt1", bankTransactionId: "tx1", targetType: "payment", targetId: "pay1" })],
    }));
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0];
    expect(e).toMatchObject({ origin: "conciliacao", originId: "tx1", status: "realizado", realizedBy: "conciliacao", kind: "saida", amountCents: 10_000, categoryId: "folha_salarios", mappingSource: "categoria_ap", cashDate: "2026-08-19", competenceDate: "2026-08-01", month: 8, year: 2026 });
    expect(r.entries.some((x) => x.origin === "contas_pagar")).toBe(false);
  });

  it("título 'Pago' sem conciliação: realizado por baixa_app (decisão A); no modo estrito vira previsto", () => {
    const input = base({
      payables: [payable({ id: "pv1", status: "paid", paidCents: 10_000 })],
      payments: [payment({ id: "pay1", payableId: "pv1" })],
    });
    const padrao = unifyCashflow(input);
    expect(padrao.entries).toHaveLength(1);
    expect(padrao.entries[0]).toMatchObject({ status: "realizado", realizedBy: "baixa_app", origin: "contas_pagar", originId: "pay1", cashDate: "2026-08-18" });

    const estrito = unifyCashflow({ ...input, options: { realizedFallback: false } });
    expect(estrito.entries).toHaveLength(1);
    expect(estrito.entries[0]).toMatchObject({ status: "previsto", origin: "contas_pagar", originId: "pay1" });
    expect(estrito.entries[0].realizedBy).toBeUndefined();
  });

  it("transferência entre contas próprias (par espelhado ±1 dia ou match transfer) é neutra", () => {
    const par = unifyCashflow(base({
      bankTransactions: [
        tx({ id: "out", amountCents: -500_000, bankAccountId: "ba_1", date: "2026-08-18", description: "TED ENTRE CONTAS" }),
        tx({ id: "in", amountCents: 500_000, bankAccountId: "ba_2", date: "2026-08-19", description: "TED RECEBIDA" }),
      ],
    }));
    expect(par.entries).toHaveLength(0);
    expect(par.excluded.filter((x) => x.reason === "transferencia_interna").map((x) => x.originId).sort()).toEqual(["in", "out"]);
    expect(par.excluded[0].criteria).toMatch(/par espelhado/);

    const explicito = unifyCashflow(base({
      bankTransactions: [tx({ id: "out", amountCents: -500_000 }), tx({ id: "in", amountCents: 500_000, bankAccountId: "ba_2" })],
      matches: [
        match({ id: "t1", bankTransactionId: "out", targetType: "transfer", targetId: "in", groupId: "g1" }),
        match({ id: "t2", bankTransactionId: "in", targetType: "transfer", targetId: "out", groupId: "g1" }),
      ],
    }));
    expect(explicito.entries).toHaveLength(0);
    expect(soma(explicito)).toBe(0);
  });

  it("categoria não mapeada cai em a_classificar e é marcada como não mapeada", () => {
    const r = unifyCashflow(base({
      payables: [payable({ id: "pv1", supplierCategory: "Categoria Inexistente", description: "Sem regra" })],
    }));
    expect(r.entries[0]).toMatchObject({ categoryId: "a_classificar", mappingSource: "nao_mapeado", status: "previsto", group: "outras" });
  });

  it("de-para: plano contábil vence categoria de fornecedor, que vence regra por texto (menor priority primeiro)", () => {
    const r = unifyCashflow(base({
      mappings: [
        ...MAPPINGS,
        mapping({ id: "m5", source: "regra_texto", sourceKey: "folha", categoryId: "beneficios", priority: 50 }),
      ],
      payables: [
        payable({ id: "a", categoryId: "cat_fornec", supplierCategory: "Folha", description: "aluguel folha" }),
        payable({ id: "b", supplierCategory: "Folha", description: "aluguel" }),
        payable({ id: "c", supplierCategory: "X", description: "Aluguel da sala e folha" }),
        payable({ id: "d", supplierCategory: "X", description: "folha extra" }),
      ],
    }));
    const cat = (id: string) => r.entries.find((e) => e.originId === id)?.categoryId;
    expect(cat("a")).toBe("fornecedores"); // plano_contas
    expect(cat("b")).toBe("folha_salarios"); // categoria_ap
    expect(cat("c")).toBe("aluguel"); // regra_texto priority 10 antes de 50
    expect(cat("d")).toBe("beneficios"); // regra_texto priority 50
  });

  it("extrato api_mock, títulos cancelados e baixas estornadas ficam fora", () => {
    const r = unifyCashflow(base({
      bankTransactions: [tx({ id: "mock", amountCents: -100, source: "api_mock" })],
      payables: [payable({ id: "canc", status: "canceled", canceledAt: NOW })],
      receivables: [receivable({ id: "rcanc", status: "canceled" })],
      receipts: [receipt({ id: "rc_est", receivableId: "rcanc", status: "canceled" })],
      payments: [payment({ id: "pay_canc", payableId: "canc", status: "canceled" })],
    }));
    expect(r.entries).toHaveLength(0);
    expect(r.excluded.map((x) => x.reason).sort()).toEqual(["cancelado", "cancelado", "extrato_mock"]);
  });

  it("baixa parcial: realizado pelo pagamento executado e previsto pelo saldo restante", () => {
    const r = unifyCashflow(base({
      payables: [payable({ id: "pv1", status: "partially_paid", paidCents: 4_000 })],
      payments: [payment({ id: "pay1", payableId: "pv1", amountCents: 4_000 })],
    }));
    expect(r.entries.map((e) => [e.status, e.amountCents, e.originId])).toEqual([
      ["realizado", 4_000, "pay1"],
      ["previsto", 6_000, "pv1"],
    ]);
  });

  it("casamento implícito (mesma conta, mesmo valor, ±3 dias) gera uma linha só e registra o critério", () => {
    const r = unifyCashflow(base({
      payables: [payable({ id: "pv1", status: "paid", paidCents: 10_000 })],
      payments: [payment({ id: "pay1", payableId: "pv1", executedAt: "2026-08-18T12:00:00.000Z" })],
      bankTransactions: [tx({ id: "tx1", amountCents: -10_000, date: "2026-08-20" })],
    }));
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ origin: "conciliacao", originId: "tx1", realizedBy: "conciliacao", cashDate: "2026-08-20" });
    expect(r.entries[0].matchCriteria).toMatch(/casamento implícito.*±3/);

    // Fora da janela (5 dias) ou em outra conta: não casa — a baixa entra pelo app e o movimento vira pendência.
    const fora = unifyCashflow(base({
      payables: [payable({ id: "pv1", status: "paid", paidCents: 10_000 })],
      payments: [payment({ id: "pay1", payableId: "pv1" })],
      bankTransactions: [tx({ id: "tx1", amountCents: -10_000, date: "2026-08-25" })],
    }));
    expect(fora.entries.map((e) => e.originId)).toEqual(["pay1"]);
    expect(fora.excluded.find((x) => x.originId === "tx1")?.reason).toBe("sem_conciliacao");
  });

  it("tarifa do banco conciliada (bank_fee) vira Tarifas Bancárias realizada", () => {
    const r = unifyCashflow(base({
      bankTransactions: [tx({ id: "fee", amountCents: -890, description: "TARIFA PIX" })],
      matches: [match({ id: "mf", bankTransactionId: "fee", targetType: "bank_fee", status: "auto_confirmed" })],
    }));
    expect(r.entries[0]).toMatchObject({ categoryId: "tarifas_bancarias", group: "financeiro", mappingSource: "conciliacao_bank_fee", amountCents: 890, status: "realizado" });
  });

  it("recebimento usa o valor total (com encargos) e a categoria a receber; conciliação sugerida NÃO conta", () => {
    const r = unifyCashflow(base({
      receivables: [receivable({ id: "rv1", status: "received", receivedCents: 20_000 })],
      receipts: [receipt({ id: "rc1", receivableId: "rv1", amountCents: 20_450, principalCents: 20_000 })],
      bankTransactions: [tx({ id: "cred", amountCents: 20_450, date: "2026-08-30" })],
      matches: [match({ id: "s1", bankTransactionId: "cred", targetType: "receipt", targetId: "rc1", status: "suggested" })],
    }));
    // Sugestão não confirmada: o crédito (30/08) não casa por data (±3 dias do recibo em 19/08) → pendência;
    // o recibo entra pelo app, pelo valor total.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ kind: "entrada", amountCents: 20_450, categoryId: "prestacao_servicos", origin: "contas_receber", originId: "rc1", realizedBy: "baixa_app" });
    expect(r.excluded.find((x) => x.originId === "cred")?.reason).toBe("sem_conciliacao");
  });

  it("mês/ano vêm da data de caixa; previsto usa vencimento ou a data agendada do pagamento pendente; competência = emissão", () => {
    const r = unifyCashflow(base({
      payables: [
        payable({ id: "venc", issueDate: "2026-05-10", dueDate: "2026-07-05" }),
        payable({ id: "agend", issueDate: "2026-05-10", dueDate: "2026-07-15", status: "scheduled" }),
      ],
      payments: [payment({ id: "pend", payableId: "agend", status: "approved", scheduledDate: "2026-07-01", executedAt: undefined })],
      receivables: [receivable({ id: "rv", issueDate: "2026-06-01", dueDate: "2027-01-10" })],
    }));
    const by = (id: string) => r.entries.find((e) => e.originId === id)!;
    expect(by("venc")).toMatchObject({ cashDate: "2026-07-05", competenceDate: "2026-05-10", month: 7, year: 2026, status: "previsto" });
    expect(by("agend")).toMatchObject({ cashDate: "2026-07-01", month: 7 });
    expect(by("rv")).toMatchObject({ cashDate: "2027-01-10", month: 1, year: 2027, kind: "entrada", amountCents: 20_000 });
  });

  it("ajuste manual entra como registrado, com origem própria", () => {
    const ajuste: CashflowManualEntry = {
      id: "aj1", companyId: CO, competenceDate: "2026-10-05", kind: "entrada", categoryId: "outras_receitas",
      description: "Aporte de sócio previsto", status: "previsto", amountCents: 50_000_00, createdBy: "usr",
      createdAt: NOW, updatedAt: NOW, version: 1,
    };
    const r = unifyCashflow(base({ manualEntries: [ajuste] }));
    expect(r.entries[0]).toMatchObject({ origin: "ajuste_manual", originId: "aj1", mappingSource: "ajuste_manual", month: 10, year: 2026, group: "receita_nao_operacional" });
  });

  it("recálculo é idempotente: mesma entrada (em qualquer ordem) → saída idêntica", () => {
    const input = base({
      payables: [payable({ id: "pv1", status: "paid", paidCents: 10_000 }), payable({ id: "pv2", dueDate: "2026-09-01" })],
      payments: [payment({ id: "pay1", payableId: "pv1" })],
      receivables: [receivable({ id: "rv1", status: "received", receivedCents: 20_000 })],
      receipts: [receipt({ id: "rc1", receivableId: "rv1" })],
      bankTransactions: [tx({ id: "tx1", amountCents: -10_000, date: "2026-08-19" }), tx({ id: "fee", amountCents: -890 })],
      matches: [match({ id: "mt1", bankTransactionId: "tx1", targetType: "payment", targetId: "pay1" }), match({ id: "mf", bankTransactionId: "fee", targetType: "bank_fee" })],
    });
    const a = unifyCashflow(input);
    const b = unifyCashflow(input);
    const embaralhado = unifyCashflow({
      ...input,
      payables: [...input.payables].reverse(),
      bankTransactions: [...input.bankTransactions].reverse(),
      matches: [...input.matches].reverse(),
    });
    expect(b).toEqual(a);
    expect(embaralhado).toEqual(a);
    expect(a.entries).toHaveLength(4);
  });

  it("normalizeKey ignora caixa, acentos e espaços repetidos", () => {
    expect(normalizeKey("  Folha   e SALÁRIOS ")).toBe("folha e salarios");
  });
});
