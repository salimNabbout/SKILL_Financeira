/**
 * DADOS FICTÍCIOS DE DEMONSTRAÇÃO — modo demo e seed do banco.
 * Usa a interface Repositories, portanto serve tanto para memória quanto Prisma.
 * Nenhum dado aqui é real; documentos, CNPJs/CPFs e chaves são inventados.
 *
 * Todas as datas de negócio são RELATIVAS a "hoje" (fuso America/Sao_Paulo),
 * para a demo continuar coerente em qualquer data de execução.
 */

import type { Clock } from "@/core/clock";
import { DEFAULT_COMPANY_CONFIG } from "@/core/config";
import { addDays, addMonths, monthOf, todayInTz, toUtcNoon, type ISODate } from "@/core/dates";
import type {
  PaymentMethod,
  ReceiptMethod,
  ReceivableStatus,
  RoleName,
} from "@/core/entities";
import type { Repositories } from "@/core/repositories";
import { hashPassword } from "@/lib/password";

export const DEMO_COMPANY_ID = "co_demo";
export const DEMO_COMPANY2_ID = "co_demo_express";
export const DEMO_PASSWORD = "demo1234";
export const DEMO_BANK_ITAU_ID = "ba_itau";
export const DEMO_BANK_NUBANK_ID = "ba_nubank";
export const DEMO_BUDGET_ID = "bud_anual";

/** Instante ISO ao meio-dia UTC de uma data de negócio (para históricos determinísticos). */
function instantOf(date: ISODate): string {
  return toUtcNoon(date).toISOString();
}

export async function seedDemoData(repos: Repositories, clock: Clock): Promise<void> {
  const now = clock.now().toISOString();
  const today = todayInTz(clock.now(), "America/Sao_Paulo");

  if (await repos.companies.getById(DEMO_COMPANY_ID)) return; // já semeado

  await repos.companies.create({
    id: DEMO_COMPANY_ID,
    name: "Café Aurora Ltda",
    legalName: "Aurora Comércio de Cafés Especiais Ltda",
    cnpj: "11.222.333/0001-44",
    timezone: "America/Sao_Paulo",
    defaultCurrency: "BRL",
    config: DEFAULT_COMPANY_CONFIG,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const demoUsers: Array<{ key: string; name: string; role: RoleName; limit: number | null }> = [
    { key: "ana", name: "Ana Prado (Admin)", role: "admin", limit: null },
    { key: "bruno", name: "Bruno Lima (Gestor Financeiro)", role: "finance_manager", limit: 5_000_000 },
    { key: "carla", name: "Carla Souza (Analista)", role: "finance_analyst", limit: 0 },
    { key: "diego", name: "Diego Alves (Aprovador)", role: "approver", limit: 500_000 },
    { key: "elisa", name: "Elisa Ramos (Contadora)", role: "accountant", limit: 0 },
  ];
  for (const u of demoUsers) {
    await repos.users.create({
      id: `usr_${u.key}`,
      name: u.name,
      email: `${u.key}@cafeaurora.com.br`,
      passwordHash,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await repos.memberships.create({
      id: `mem_${u.key}`,
      userId: `usr_${u.key}`,
      companyId: DEMO_COMPANY_ID,
      role: u.role,
      approvalLimitCents: u.limit,
    });
  }

  await repos.bankAccounts.create({
    id: DEMO_BANK_ITAU_ID,
    companyId: DEMO_COMPANY_ID,
    name: "Conta Movimento Itaú",
    bankCode: "341",
    agency: "0912",
    accountNumberMasked: "****-3341",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 4_250_000, // R$ 42.500,00
    openingBalanceDate: today,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  await repos.bankAccounts.create({
    id: DEMO_BANK_NUBANK_ID,
    companyId: DEMO_COMPANY_ID,
    name: "Conta Reserva Nubank",
    bankCode: "260",
    agency: "0001",
    accountNumberMasked: "****-8260",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 1_830_000, // R$ 18.300,00
    openingBalanceDate: today,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  const categories: Array<[string, string, "income" | "expense", string]> = [
    ["cat_vendas", "Vendas de mercadorias", "income", "receita_bruta"],
    ["cat_servicos", "Receita de serviços", "income", "receita_bruta"],
    ["cat_fin_receita", "Receitas financeiras", "income", "receitas_financeiras"],
    ["cat_insumos", "Insumos e mercadorias", "expense", "custos"],
    ["cat_frete", "Fretes e logística", "expense", "custos"],
    ["cat_pessoal", "Pessoal e encargos", "expense", "despesas_operacionais"],
    ["cat_aluguel", "Aluguel e condomínio", "expense", "despesas_operacionais"],
    ["cat_energia", "Energia elétrica", "expense", "despesas_operacionais"],
    ["cat_telecom", "Internet e telecom", "expense", "despesas_operacionais"],
    ["cat_marketing", "Marketing e anúncios", "expense", "despesas_operacionais"],
    ["cat_software", "Software e assinaturas", "expense", "despesas_operacionais"],
    ["cat_impostos", "Impostos e tributos", "expense", "deducoes"],
    ["cat_tarifas", "Tarifas bancárias e juros", "expense", "despesas_financeiras"],
  ];
  for (const [id, name, kind, dreGroup] of categories) {
    await repos.categories.create({
      id,
      companyId: DEMO_COMPANY_ID,
      name,
      kind,
      dreGroup: dreGroup as never,
      active: true,
    });
  }

  const costCenters: Array<[string, string, string]> = [
    ["cc_loja", "CC-01", "Loja física"],
    ["cc_ecom", "CC-02", "E-commerce"],
    ["cc_adm", "CC-03", "Administrativo"],
  ];
  for (const [id, code, name] of costCenters) {
    await repos.costCenters.create({ id, companyId: DEMO_COMPANY_ID, code, name, active: true });
  }

  const chart: Array<[string, string, string, string | undefined]> = [
    ["1", "Ativo", "asset", undefined],
    ["1.1", "Caixa e bancos", "asset", "1"],
    ["1.2", "Contas a receber", "asset", "1"],
    ["2", "Passivo", "liability", undefined],
    ["2.1", "Fornecedores a pagar", "liability", "2"],
    ["2.2", "Obrigações fiscais", "liability", "2"],
    ["3", "Receitas", "revenue", undefined],
    ["3.1", "Receita de vendas", "revenue", "3"],
    ["4", "Despesas", "expense", undefined],
    ["4.1", "Custos de mercadorias", "expense", "4"],
    ["4.2", "Despesas operacionais", "expense", "4"],
    ["4.3", "Despesas financeiras", "expense", "4"],
  ];
  for (const [code, name, type, parentCode] of chart) {
    await repos.chartAccounts.create({
      id: `coa_${code.replace(/\./g, "_")}`,
      companyId: DEMO_COMPANY_ID,
      code,
      name,
      type: type as never,
      parentCode,
      active: true,
    });
  }

  // -------------------------------------------------------------------------
  // Fornecedores (CNPJs fictícios)
  // -------------------------------------------------------------------------
  const suppliers: Array<[string, string, string, string]> = [
    ["sup_torrefacao", "Torrefação Serra Alta Ltda", "23.456.789/0001-10", "vendas@serraalta.example.com.br"],
    ["sup_embalagens", "Embalagens Prima Ltda", "34.567.890/0001-21", "comercial@embprima.example.com.br"],
    ["sup_energia", "Luz & Força Energia S.A.", "45.678.901/0001-32", "faturas@luzforca.example.com.br"],
    ["sup_aluguel", "Imobiliária Bela Vista Ltda", "56.789.012/0001-43", "contato@belavista.example.com.br"],
    ["sup_marketing", "Agência Pulso Digital Ltda", "67.890.123/0001-54", "financeiro@pulsodigital.example.com.br"],
    ["sup_software", "NuvemSoft Sistemas Ltda", "78.901.234/0001-65", "billing@nuvemsoft.example.com.br"],
  ];
  for (const [id, name, document, email] of suppliers) {
    await repos.suppliers.create({
      id,
      companyId: DEMO_COMPANY_ID,
      name,
      document,
      email,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  // -------------------------------------------------------------------------
  // Clientes (CNPJ/CPF fictícios)
  // -------------------------------------------------------------------------
  const customers: Array<[string, string, string, string]> = [
    ["cus_grao_centro", "Cafeteria Grão do Centro Ltda", "19.876.543/0001-01", "pedidos@graodocentro.example.com.br"],
    ["cus_cafe_vila", "Café da Vila Ltda", "28.765.432/0001-12", "compras@cafedavila.example.com.br"],
    ["cus_sabor_caseiro", "Restaurante Sabor Caseiro Ltda", "37.654.321/0001-23", "adm@saborcaseiro.example.com.br"],
    ["cus_fogao_minas", "Fogão de Minas Restaurante Ltda", "46.543.210/0001-34", "financeiro@fogaodeminas.example.com.br"],
    ["cus_bistro_jardim", "Bistrô Jardim Ltda", "55.432.109/0001-45", "contato@bistrojardim.example.com.br"],
    ["cus_bebidas_online", "Bebidas Online Comércio Digital Ltda", "64.321.098/0001-56", "compras@bebidasonline.example.com.br"],
    ["cus_emporio_clara", "Empório Santa Clara Ltda", "73.210.987/0001-67", "emporio@santaclara.example.com.br"],
    ["cus_marina_pf", "Marina Duarte", "123.456.789-09", "marina.duarte@example.com.br"],
  ];
  for (const [id, name, document, email] of customers) {
    await repos.customers.create({
      id,
      companyId: DEMO_COMPANY_ID,
      name,
      document,
      email,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  // -------------------------------------------------------------------------
  // Contas a pagar (14 títulos: 3 vencidos, 4 próximos 7 dias, 5 em 8-45 dias
  // — com um par de duplicatas plantadas — e 2 pagos no mês passado)
  // -------------------------------------------------------------------------
  interface PayableSeed {
    id: string;
    supplierId: string;
    description: string;
    dueDate: ISODate;
    amountCents: number;
    categoryId: string;
    costCenterId: string;
    originKey: string;
    installmentNumber?: number;
    installmentCount?: number;
    paid?: boolean;
  }

  const lastMonth = addMonths(today, -1);
  const paidDate1 = lastMonth; // ~30 dias atrás
  const paidDate2 = addDays(lastMonth, 2);

  const payableSeeds: PayableSeed[] = [
    // Vencidos
    { id: "pv_ov_1", supplierId: "sup_energia", description: "Conta de energia elétrica — loja", dueDate: addDays(today, -7), amountCents: 148_050, categoryId: "cat_energia", costCenterId: "cc_loja", originKey: "sup_energia:FAT-77201:1/1" },
    { id: "pv_ov_2", supplierId: "sup_embalagens", description: "Embalagens para grãos 500g", dueDate: addDays(today, -15), amountCents: 234_000, categoryId: "cat_insumos", costCenterId: "cc_loja", originKey: "sup_embalagens:NF-8811:1/1" },
    { id: "pv_ov_3", supplierId: "sup_marketing", description: "Campanha de mídia paga — mês anterior", dueDate: addDays(today, -32), amountCents: 360_000, categoryId: "cat_marketing", costCenterId: "cc_ecom", originKey: "sup_marketing:NF-451:1/1" },
    // Vencendo nos próximos 7 dias
    { id: "pv_n7_1", supplierId: "sup_aluguel", description: "Aluguel da loja física", dueDate: addDays(today, 2), amountCents: 650_000, categoryId: "cat_aluguel", costCenterId: "cc_loja", originKey: "sup_aluguel:REC-118:1/1" },
    { id: "pv_n7_2", supplierId: "sup_software", description: "Assinatura mensal do ERP", dueDate: addDays(today, 4), amountCents: 89_000, categoryId: "cat_software", costCenterId: "cc_adm", originKey: "sup_software:FAT-3302:1/1" },
    { id: "pv_n7_3", supplierId: "sup_torrefacao", description: "Lote de café verde — parcela 1/2", dueDate: addDays(today, 5), amountCents: 980_000, categoryId: "cat_insumos", costCenterId: "cc_loja", originKey: "sup_torrefacao:NF-1290:1/2", installmentNumber: 1, installmentCount: 2 },
    { id: "pv_n7_4", supplierId: "sup_energia", description: "Conta de energia elétrica — galpão", dueDate: addDays(today, 7), amountCents: 192_030, categoryId: "cat_energia", costCenterId: "cc_adm", originKey: "sup_energia:FAT-77982:1/1" },
    // 8 a 45 dias (inclui par de duplicatas plantadas: mesmo fornecedor+valor+vencimento)
    { id: "pv_dup_a", supplierId: "sup_embalagens", description: "Caixas para e-commerce", dueDate: addDays(today, 12), amountCents: 185_000, categoryId: "cat_insumos", costCenterId: "cc_ecom", originKey: "sup_embalagens:NF-9034:1/1" },
    { id: "pv_dup_b", supplierId: "sup_embalagens", description: "Caixas para e-commerce (lançamento em duplicidade)", dueDate: addDays(today, 12), amountCents: 185_000, categoryId: "cat_insumos", costCenterId: "cc_ecom", originKey: "sup_embalagens:NF-9034B:1/1" },
    { id: "pv_f_1", supplierId: "sup_marketing", description: "Produção de conteúdo mensal", dueDate: addDays(today, 20), amountCents: 275_000, categoryId: "cat_marketing", costCenterId: "cc_ecom", originKey: "sup_marketing:NF-472:1/1" },
    { id: "pv_f_2", supplierId: "sup_torrefacao", description: "Lote de café verde — parcela 2/2", dueDate: addDays(today, 35), amountCents: 980_000, categoryId: "cat_insumos", costCenterId: "cc_loja", originKey: "sup_torrefacao:NF-1290:2/2", installmentNumber: 2, installmentCount: 2 },
    { id: "pv_f_3", supplierId: "sup_software", description: "Renovação anual da licença de BI", dueDate: addDays(today, 45), amountCents: 432_000, categoryId: "cat_software", costCenterId: "cc_adm", originKey: "sup_software:FAT-3400:1/1" },
    // Pagos no mês passado (alimentam DRE/contabilidade)
    { id: "pv_paid_1", supplierId: "sup_torrefacao", description: "Lote de café verde — mês anterior", dueDate: paidDate1, amountCents: 780_000, categoryId: "cat_insumos", costCenterId: "cc_loja", originKey: "sup_torrefacao:NF-1105:1/1", paid: true },
    { id: "pv_paid_2", supplierId: "sup_energia", description: "Conta de energia elétrica — mês anterior", dueDate: paidDate2, amountCents: 139_520, categoryId: "cat_energia", costCenterId: "cc_loja", originKey: "sup_energia:FAT-76410:1/1", paid: true },
  ];

  for (const p of payableSeeds) {
    await repos.payables.create({
      id: p.id,
      companyId: DEMO_COMPANY_ID,
      supplierId: p.supplierId,
      description: p.description,
      issueDate: addDays(p.dueDate, -28),
      dueDate: p.dueDate,
      amountCents: p.amountCents,
      paidCents: p.paid ? p.amountCents : 0,
      currency: "BRL",
      status: p.paid ? "paid" : "open",
      categoryId: p.categoryId,
      costCenterId: p.costCenterId,
      installmentNumber: p.installmentNumber ?? 1,
      installmentCount: p.installmentCount ?? 1,
      originKey: p.originKey,
      createdBy: "usr_carla",
      createdAt: instantOf(addDays(p.dueDate, -28)),
      updatedAt: now,
    });
  }

  // Pagamentos executados dos títulos pagos, com aprovação humana registrada
  // (segregação: solicitado por usr_carla, decidido por usr_bruno).
  const paymentSeeds: Array<{
    payId: string;
    approvalId: string;
    payableId: string;
    amountCents: number;
    date: ISODate;
    method: PaymentMethod;
    requiredRole: RoleName;
    summary: string;
  }> = [
    {
      payId: "pay_seed_1",
      approvalId: "apr_seed_1",
      payableId: "pv_paid_1",
      amountCents: 780_000,
      date: paidDate1,
      method: "ted",
      requiredRole: "finance_manager",
      summary: "Pagamento Torrefação Serra Alta — lote de café verde (R$ 7.800,00)",
    },
    {
      payId: "pay_seed_2",
      approvalId: "apr_seed_2",
      payableId: "pv_paid_2",
      amountCents: 139_520,
      date: paidDate2,
      method: "pix",
      requiredRole: "approver",
      summary: "Pagamento Luz & Força Energia — fatura mensal (R$ 1.395,20)",
    },
  ];

  for (const ps of paymentSeeds) {
    await repos.approvals.create({
      id: ps.approvalId,
      companyId: DEMO_COMPANY_ID,
      targetType: "payment",
      targetId: ps.payId,
      summary: ps.summary,
      amountCents: ps.amountCents,
      requestedBy: "usr_carla",
      requiredRole: ps.requiredRole,
      status: "approved",
      decidedBy: "usr_bruno",
      decidedAt: instantOf(addDays(ps.date, -1)),
      justification: "Pagamento recorrente previsto no orçamento.",
      createdAt: instantOf(addDays(ps.date, -2)),
    });
    await repos.payments.create({
      id: ps.payId,
      companyId: DEMO_COMPANY_ID,
      payableId: ps.payableId,
      bankAccountId: DEMO_BANK_ITAU_ID,
      amountCents: ps.amountCents,
      scheduledDate: ps.date,
      executedAt: instantOf(ps.date),
      status: "executed",
      method: ps.method,
      approvalId: ps.approvalId,
      requestedBy: "usr_carla",
      executedBy: "usr_bruno",
      createdAt: instantOf(addDays(ps.date, -2)),
      updatedAt: instantOf(ps.date),
    });
  }

  // -------------------------------------------------------------------------
  // Faturas (NF mock) e contas a receber
  // -------------------------------------------------------------------------
  const invoiceSeeds: Array<{
    id: string;
    customerId: string;
    description: string;
    totalCents: number;
    issueDate?: ISODate;
    issued: boolean;
    number?: string;
  }> = [
    { id: "inv_1001", customerId: "cus_bebidas_online", description: "Fornecimento mensal — e-commerce", totalCents: 590_000, issueDate: addDays(today, -27), issued: true, number: "1001" },
    { id: "inv_1002", customerId: "cus_emporio_clara", description: "Fornecimento quinzenal — empório", totalCents: 415_000, issueDate: addDays(today, -22), issued: true, number: "1002" },
    { id: "inv_1003", customerId: "cus_cafe_vila", description: "Pedido especial — blends de inverno", totalCents: 312_000, issued: false },
  ];
  for (const inv of invoiceSeeds) {
    await repos.invoices.create({
      id: inv.id,
      companyId: DEMO_COMPANY_ID,
      customerId: inv.customerId,
      description: inv.description,
      totalCents: inv.totalCents,
      issueDate: inv.issueDate,
      status: inv.issued ? "issued" : "draft",
      nfeMock:
        inv.issued && inv.issueDate && inv.number
          ? {
              number: inv.number,
              accessKey: `9999${inv.number.padStart(8, "0")}0001000000000000000000000000000000000001`,
              issuedAt: instantOf(inv.issueDate),
              provider: "mock",
            }
          : undefined,
      createdBy: "usr_carla",
      createdAt: inv.issueDate ? instantOf(inv.issueDate) : now,
      updatedAt: now,
    });
  }

  interface ReceivableSeed {
    id: string;
    customerId: string;
    invoiceId?: string;
    description: string;
    dueDate: ISODate;
    amountCents: number;
    categoryId: string;
    costCenterId: string;
    originKey: string;
    status?: ReceivableStatus;
    method?: ReceiptMethod;
    receivedDate?: ISODate;
  }

  const receivedDate1 = addDays(lastMonth, 1);
  const receivedDate2 = addDays(lastMonth, 4);

  const receivableSeeds: ReceivableSeed[] = [
    // Vencidos
    { id: "rc_ov_1", customerId: "cus_sabor_caseiro", description: "Pedido 1042 — fornecimento mensal de café", dueDate: addDays(today, -5), amountCents: 345_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1042:1/1" },
    { id: "rc_ov_2", customerId: "cus_grao_centro", description: "Pedido 1031 — grãos especiais", dueDate: addDays(today, -12), amountCents: 218_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1031:1/1" },
    { id: "rc_ov_3", customerId: "cus_bistro_jardim", description: "Pedido 1017 — assinatura de cafés", dueDate: addDays(today, -25), amountCents: 156_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1017:1/1" },
    { id: "rc_ov_4", customerId: "cus_marina_pf", description: "Pedido 0998 — kit degustação", dueDate: addDays(today, -40), amountCents: 48_000, categoryId: "cat_vendas", costCenterId: "cc_ecom", originKey: "ped:0998:1/1" },
    // Próximos 15 dias (dois ligados a faturas emitidas)
    { id: "rc_n_1", customerId: "cus_bebidas_online", invoiceId: "inv_1001", description: "NF 1001 — fornecimento mensal e-commerce", dueDate: addDays(today, 3), amountCents: 590_000, categoryId: "cat_vendas", costCenterId: "cc_ecom", originKey: "inv:inv_1001:1/1" },
    { id: "rc_n_2", customerId: "cus_emporio_clara", invoiceId: "inv_1002", description: "NF 1002 — fornecimento quinzenal empório", dueDate: addDays(today, 8), amountCents: 415_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "inv:inv_1002:1/1" },
    { id: "rc_n_3", customerId: "cus_cafe_vila", description: "Pedido 1055 — reposição de estoque", dueDate: addDays(today, 12), amountCents: 264_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1055:1/1" },
    { id: "rc_n_4", customerId: "cus_fogao_minas", description: "Pedido 1058 — fornecimento mensal", dueDate: addDays(today, 15), amountCents: 398_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1058:1/1" },
    // Recebidos no mês passado
    { id: "rc_pd_1", customerId: "cus_grao_centro", description: "Pedido 1002 — fornecimento mensal", dueDate: receivedDate1, amountCents: 487_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1002:1/1", status: "received", method: "pix", receivedDate: receivedDate1 },
    { id: "rc_pd_2", customerId: "cus_bebidas_online", description: "Pedido 1005 — fornecimento e-commerce", dueDate: receivedDate2, amountCents: 623_000, categoryId: "cat_vendas", costCenterId: "cc_ecom", originKey: "ped:1005:1/1", status: "received", method: "boleto", receivedDate: receivedDate2 },
    // Mês seguinte
    { id: "rc_nm_1", customerId: "cus_emporio_clara", description: "Pedido 1077 — fornecimento programado", dueDate: addMonths(today, 1), amountCents: 540_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1077:1/1" },
    { id: "rc_nm_2", customerId: "cus_sabor_caseiro", description: "Pedido 1080 — fornecimento programado", dueDate: addDays(addMonths(today, 1), 5), amountCents: 345_000, categoryId: "cat_vendas", costCenterId: "cc_loja", originKey: "ped:1080:1/1" },
  ];

  for (const r of receivableSeeds) {
    const received = r.status === "received";
    await repos.receivables.create({
      id: r.id,
      companyId: DEMO_COMPANY_ID,
      customerId: r.customerId,
      invoiceId: r.invoiceId,
      description: r.description,
      issueDate: addDays(r.dueDate, -30),
      dueDate: r.dueDate,
      amountCents: r.amountCents,
      receivedCents: received ? r.amountCents : 0,
      currency: "BRL",
      status: r.status ?? "open",
      method: r.method,
      categoryId: r.categoryId,
      costCenterId: r.costCenterId,
      installmentNumber: 1,
      installmentCount: 1,
      originKey: r.originKey,
      createdBy: "usr_carla",
      createdAt: instantOf(addDays(r.dueDate, -30)),
      updatedAt: now,
    });
  }

  const receiptSeeds: Array<{ id: string; receivableId: string; amountCents: number; date: ISODate; method: ReceiptMethod }> = [
    { id: "rcp_seed_1", receivableId: "rc_pd_1", amountCents: 487_000, date: receivedDate1, method: "pix" },
    { id: "rcp_seed_2", receivableId: "rc_pd_2", amountCents: 623_000, date: receivedDate2, method: "boleto" },
  ];
  for (const rc of receiptSeeds) {
    await repos.receipts.create({
      id: rc.id,
      companyId: DEMO_COMPANY_ID,
      receivableId: rc.receivableId,
      bankAccountId: DEMO_BANK_ITAU_ID,
      amountCents: rc.amountCents,
      receivedDate: rc.date,
      method: rc.method,
      registeredBy: "usr_carla",
      createdAt: instantOf(rc.date),
    });
  }

  // -------------------------------------------------------------------------
  // Extrato bancário (ba_itau, últimos 45 dias) — NADA conciliado: a demo
  // mostra a conciliação em ação. Créditos/débitos casam com receipts/payments.
  // -------------------------------------------------------------------------
  const txSeeds: Array<{ date: ISODate; amountCents: number; description: string }> = [
    // Casam exatamente com os dois recebimentos registrados
    { date: receivedDate1, amountCents: 487_000, description: "PIX RECEBIDO CAFETERIA GRAO DO CENTRO" },
    { date: receivedDate2, amountCents: 623_000, description: "LIQ COBRANCA BOLETO BEBIDAS ONLINE" },
    // Casam exatamente com os dois pagamentos executados
    { date: paidDate1, amountCents: -780_000, description: "TED ENVIADA TORREFACAO SERRA ALTA" },
    { date: paidDate2, amountCents: -139_520, description: "PIX ENVIADO LUZ E FORCA ENERGIA" },
    // Movimentações diversas (tarifas, PIX, débitos automáticos)
    { date: addDays(today, -30), amountCents: -4_990, description: "TARIFA MANUTENCAO CONTA" },
    { date: addDays(today, -20), amountCents: 152_000, description: "PIX RECEBIDO PEDIDO BALCAO" },
    { date: addDays(today, -18), amountCents: 45_000, description: "PIX RECEBIDO KIT DEGUSTACAO" },
    { date: addDays(today, -16), amountCents: -3_550, description: "TARIFA COBRANCA BOLETOS" },
    { date: addDays(today, -14), amountCents: 98_500, description: "PIX RECEBIDO PEDIDO BALCAO" },
    { date: addDays(today, -13), amountCents: -62_000, description: "PIX ENVIADO FRETE TRANSPORTADORA" },
    { date: addDays(today, -11), amountCents: 176_400, description: "PIX RECEBIDO EMPORIO SANTA CLARA" },
    { date: addDays(today, -9), amountCents: -890, description: "TARIFA PIX" }, // débito de R$ 8,90
    { date: addDays(today, -8), amountCents: -18_990, description: "DEB AUTOMATICO INTERNET TELECOM" },
    { date: addDays(today, -6), amountCents: 204_300, description: "PIX RECEBIDO CAFE DA VILA" },
    { date: addDays(today, -5), amountCents: -35_000, description: "PIX ENVIADO MANUTENCAO MAQUINAS" },
    { date: addDays(today, -4), amountCents: 88_000, description: "PIX RECEBIDO PEDIDO BALCAO" },
    // Crédito grande (~3x a média) para o detector de anomalias
    { date: addDays(today, -3), amountCents: 1_200_000, description: "PIX RECEBIDO VENDA CORPORATIVA EVENTO" },
    { date: addDays(today, -2), amountCents: -12_450, description: "COMPRA DEBITO MATERIAL DE LIMPEZA" },
    { date: addDays(today, -1), amountCents: 134_900, description: "PIX RECEBIDO RESTAURANTE SABOR CASEIRO" },
    { date: addDays(paidDate1, 1), amountCents: -7_900, description: "TARIFA TED" },
  ];
  for (let i = 0; i < txSeeds.length; i++) {
    const tx = txSeeds[i];
    await repos.bankTransactions.create({
      id: `btx_seed_${i + 1}`,
      companyId: DEMO_COMPANY_ID,
      bankAccountId: DEMO_BANK_ITAU_ID,
      date: tx.date,
      amountCents: tx.amountCents,
      currency: "BRL",
      description: tx.description,
      externalId: `seed-${i + 1}`,
      importBatchId: "imp_seed_1",
      source: "csv",
      reconciled: false,
      createdAt: now,
    });
  }

  // -------------------------------------------------------------------------
  // Orçamento anual: linhas mensais (mês passado, atual e próximos 2) para
  // 6 categorias — insumos, energia e marketing apertados p/ gerar desvio.
  // -------------------------------------------------------------------------
  await repos.budgets.create({
    id: DEMO_BUDGET_ID,
    companyId: DEMO_COMPANY_ID,
    name: "Orçamento Anual",
    year: Number(today.slice(0, 4)),
    status: "active",
    createdAt: now,
  });

  const budgetMonths = [-1, 0, 1, 2].map((m) => monthOf(addMonths(today, m)));
  const budgetAmounts: Array<[string, number]> = [
    ["cat_vendas", 2_500_000], // R$ 25.000,00 de receita esperada
    ["cat_insumos", 900_000], // apertado: compras de café superam com folga
    ["cat_pessoal", 1_200_000],
    ["cat_aluguel", 650_000],
    ["cat_energia", 300_000], // apertado frente às faturas lançadas
    ["cat_marketing", 300_000], // apertado frente às campanhas contratadas
  ];
  for (let m = 0; m < budgetMonths.length; m++) {
    for (const [categoryId, amountCents] of budgetAmounts) {
      await repos.budgetLines.create({
        id: `bl_m${m}_${categoryId}`,
        budgetId: DEMO_BUDGET_ID,
        period: budgetMonths[m],
        categoryId,
        amountCents,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Histórico de cobrança: lembrete (etapa 1) enviado para o título mais antigo
  // -------------------------------------------------------------------------
  const dunningSentDate = addDays(today, -37); // 3 dias após o vencimento de rc_ov_4
  await repos.collectionMessages.create({
    id: "cm_seed_1",
    companyId: DEMO_COMPANY_ID,
    receivableId: "rc_ov_4",
    customerId: "cus_marina_pf",
    step: 1,
    channel: "email",
    subject: "Lembrete de vencimento — Café Aurora Ltda",
    body:
      "Olá, Marina Duarte. Identificamos que o título de R$ 480,00 com vencimento recente está em aberto há 3 dias. Se o pagamento já foi feito, desconsidere. Qualquer dúvida, estamos à disposição.",
    status: "sent",
    sentAt: instantOf(dunningSentDate),
    createdAt: instantOf(dunningSentDate),
    updatedAt: instantOf(dunningSentDate),
  });

  // -------------------------------------------------------------------------
  // Segunda empresa: demonstra multiempresa (isolamento por companyId) e a
  // troca de empresa na sessão. Ana (admin) e Bruno (gestor) atuam nas duas.
  // -------------------------------------------------------------------------
  await repos.companies.create({
    id: DEMO_COMPANY2_ID,
    name: "Aurora Café Express Ltda",
    legalName: "Aurora Café Express Comércio de Bebidas Ltda",
    cnpj: "22.333.444/0001-55",
    timezone: "America/Sao_Paulo",
    defaultCurrency: "BRL",
    config: DEFAULT_COMPANY_CONFIG,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await repos.memberships.create({
    id: "mem_ana_express",
    userId: "usr_ana",
    companyId: DEMO_COMPANY2_ID,
    role: "admin",
    approvalLimitCents: null,
  });
  await repos.memberships.create({
    id: "mem_bruno_express",
    userId: "usr_bruno",
    companyId: DEMO_COMPANY2_ID,
    role: "finance_manager",
    approvalLimitCents: 5_000_000,
  });
  await repos.bankAccounts.create({
    id: "ba_express",
    companyId: DEMO_COMPANY2_ID,
    name: "Conta Movimento Express",
    bankCode: "077",
    agency: "0001",
    accountNumberMasked: "****-9077",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 750_000, // R$ 7.500,00
    openingBalanceDate: today,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await repos.categories.create({
    id: "cat2_vendas",
    companyId: DEMO_COMPANY2_ID,
    name: "Vendas de mercadorias",
    kind: "income",
    dreGroup: "receita_bruta",
    active: true,
  });
  await repos.categories.create({
    id: "cat2_insumos",
    companyId: DEMO_COMPANY2_ID,
    name: "Insumos e mercadorias",
    kind: "expense",
    dreGroup: "custos",
    active: true,
  });
}
