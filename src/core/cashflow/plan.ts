/**
 * Plano de categorias da disciplina Fluxo de Caixa — reprodução fiel das 37
 * categorias da planilha "Fluxo de Caixa CETEM" (aba Parâmetros), mais a
 * categoria reservada `transferencia_interna` (neutra: movimento entre contas
 * próprias, fora do resultado e fora da grade).
 *
 * É dado de referência, igual para todas as empresas: a tabela `fc_categoria`
 * é semeada a partir daqui (migration 0020) e o adaptador em memória a usa
 * direto. Os ids são slugs estáveis — são eles que o de-para (`fc_mapeamento`)
 * e os ajustes manuais referenciam, então NUNCA renomeie um id existente.
 */

import type {
  CashflowCategory,
  CashflowClassification,
  CashflowGroup,
  CashflowKind,
} from "@/core/entities";

/** Rótulo pt-BR de cada grupo, na ordem em que a planilha os apresenta. */
export const CASHFLOW_GROUP_LABEL: Record<CashflowGroup, string> = {
  receita_operacional: "Receita Operacional",
  receita_nao_operacional: "Receita Não Operacional",
  pessoal: "Pessoal",
  operacional: "Operacional",
  tributos: "Tributos",
  financeiro: "Financeiro",
  crescimento: "Crescimento",
  outras: "Outras",
};

export const CASHFLOW_GROUP_ORDER: readonly CashflowGroup[] = [
  "receita_operacional",
  "receita_nao_operacional",
  "pessoal",
  "operacional",
  "tributos",
  "financeiro",
  "crescimento",
  "outras",
];

/** Grupos de SAÍDA (os seis subtotais da aba "Fluxo Mensal"). */
export const CASHFLOW_EXPENSE_GROUPS: readonly CashflowGroup[] = [
  "pessoal",
  "operacional",
  "tributos",
  "financeiro",
  "crescimento",
  "outras",
];

/** Id reservado: lançamento sem categoria mapeada (fila de revisão). */
export const CASHFLOW_UNCLASSIFIED_ID = "a_classificar";
/** Id reservado: transferência entre contas próprias (neutra, fora da grade). */
export const CASHFLOW_TRANSFER_ID = "transferencia_interna";
/** Id da categoria que recebe as tarifas do próprio banco (match `bank_fee`). */
export const CASHFLOW_BANK_FEE_ID = "tarifas_bancarias";

type Row = [
  id: string,
  name: string,
  kind: CashflowKind,
  group: CashflowGroup,
  classification: CashflowClassification,
];

// Ordem = ordem da planilha. Fixo/variável segue a planilha: Pessoal é fixo;
// Aluguel, Condomínio, Internet e Telefonia, Tributos Municipais, Tarifas
// Bancárias, Empréstimos e Financiamentos, Software e Assinaturas,
// Consultorias e Contabilidade e Seguros são fixos; o restante é variável.
const ROWS: Row[] = [
  // Entradas
  ["vendas_produtos", "Vendas de Produtos", "entrada", "receita_operacional", "variavel"],
  ["prestacao_servicos", "Prestação de Serviços", "entrada", "receita_operacional", "variavel"],
  ["receita_financeira", "Receita Financeira", "entrada", "receita_nao_operacional", "variavel"],
  ["outras_receitas", "Outras Receitas", "entrada", "receita_nao_operacional", "variavel"],
  // Pessoal
  ["folha_salarios", "Folha e Salários", "saida", "pessoal", "fixo"],
  ["pro_labore", "Pró-labore", "saida", "pessoal", "fixo"],
  ["encargos_inss", "Encargos INSS", "saida", "pessoal", "fixo"],
  ["encargos_fgts", "Encargos FGTS", "saida", "pessoal", "fixo"],
  ["beneficios", "Benefícios (VR/VT/Saúde)", "saida", "pessoal", "fixo"],
  // Operacional
  ["aluguel", "Aluguel", "saida", "operacional", "fixo"],
  ["condominio", "Condomínio", "saida", "operacional", "fixo"],
  ["energia_eletrica", "Energia Elétrica", "saida", "operacional", "variavel"],
  ["agua_esgoto", "Água e Esgoto", "saida", "operacional", "variavel"],
  ["internet_telefonia", "Internet e Telefonia", "saida", "operacional", "fixo"],
  ["fornecedores", "Fornecedores", "saida", "operacional", "variavel"],
  ["materiais_equipamentos", "Materiais e Equipamentos", "saida", "operacional", "variavel"],
  ["frete_logistica", "Frete e Logística", "saida", "operacional", "variavel"],
  // Tributos
  ["simples_nacional_das", "Simples Nacional / DAS", "saida", "tributos", "variavel"],
  ["irpj", "IRPJ", "saida", "tributos", "variavel"],
  ["csll", "CSLL", "saida", "tributos", "variavel"],
  ["pis_cofins", "PIS / COFINS", "saida", "tributos", "variavel"],
  ["iss", "ISS", "saida", "tributos", "variavel"],
  ["icms", "ICMS", "saida", "tributos", "variavel"],
  ["tributos_municipais", "Tributos Municipais", "saida", "tributos", "fixo"],
  // Financeiro
  ["tarifas_bancarias", "Tarifas Bancárias", "saida", "financeiro", "fixo"],
  ["juros_multas", "Juros e Multas", "saida", "financeiro", "variavel"],
  ["emprestimos_financiamentos", "Empréstimos e Financiamentos", "saida", "financeiro", "fixo"],
  ["cartao_credito", "Cartão de Crédito", "saida", "financeiro", "variavel"],
  // Crescimento
  ["marketing_publicidade", "Marketing e Publicidade", "saida", "crescimento", "variavel"],
  ["software_assinaturas", "Software e Assinaturas", "saida", "crescimento", "fixo"],
  ["consultorias_contabilidade", "Consultorias e Contabilidade", "saida", "crescimento", "fixo"],
  ["treinamento_certificacoes", "Treinamento e Certificações", "saida", "crescimento", "variavel"],
  // Outras
  ["manutencao", "Manutenção", "saida", "outras", "variavel"],
  ["seguros", "Seguros", "saida", "outras", "fixo"],
  ["combustivel_deslocamento", "Combustível e Deslocamento", "saida", "outras", "variavel"],
  ["viagens_hospedagem", "Viagens e Hospedagem", "saida", "outras", "variavel"],
  [CASHFLOW_UNCLASSIFIED_ID, "A Classificar", "saida", "outras", "variavel"],
  // Reservada (fora da planilha): neutra, nunca entra no resultado.
  [CASHFLOW_TRANSFER_ID, "Transferência entre contas próprias", "neutro", "outras", "variavel"],
];

/** As 37 categorias da planilha + `transferencia_interna`, na ordem da planilha. */
export const CASHFLOW_CATEGORY_PLAN: readonly CashflowCategory[] = ROWS.map(
  ([id, name, kind, group, classification], i) => ({
    id,
    name,
    kind,
    group,
    classification,
    sortOrder: i + 1,
    active: true,
  })
);

/** Cópia mutável do plano (para semear bancos em memória). */
export function seedCashflowCategories(): CashflowCategory[] {
  return CASHFLOW_CATEGORY_PLAN.map((c) => ({ ...c }));
}

/** Premissas dos três cenários da planilha, em pontos-base (1% = 100). */
export const CASHFLOW_SCENARIO_SEED: ReadonlyArray<{
  code: "otimista" | "realista" | "pessimista";
  name: string;
  revenueAdjustmentBp: number;
  expenseAdjustmentBp: number;
  monthlyGrowthBp: number;
}> = [
  { code: "otimista", name: "Otimista", revenueAdjustmentBp: 1500, expenseAdjustmentBp: 0, monthlyGrowthBp: 0 },
  { code: "realista", name: "Realista", revenueAdjustmentBp: 0, expenseAdjustmentBp: 0, monthlyGrowthBp: 0 },
  { code: "pessimista", name: "Pessimista", revenueAdjustmentBp: -2000, expenseAdjustmentBp: 500, monthlyGrowthBp: 0 },
];
