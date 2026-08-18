/**
 * DADOS FICTÍCIOS DE DEMONSTRAÇÃO — modo demo e seed do banco.
 * Usa a interface Repositories, portanto serve tanto para memória quanto Prisma.
 * Nenhum dado aqui é real; documentos e chaves são inventados.
 */

import type { Clock } from "@/core/clock";
import { DEFAULT_COMPANY_CONFIG } from "@/core/config";
import { todayInTz } from "@/core/dates";
import type { RoleName } from "@/core/entities";
import type { Repositories } from "@/core/repositories";
import { hashPassword } from "@/lib/password";

export const DEMO_COMPANY_ID = "co_demo";
export const DEMO_PASSWORD = "demo1234";

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
    id: "ba_itau",
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
}
