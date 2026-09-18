import { describe, expect, it } from "vitest";
import {
  CASHFLOW_BANK_FEE_ID,
  CASHFLOW_CATEGORY_PLAN,
  CASHFLOW_EXPENSE_GROUPS,
  CASHFLOW_GROUP_ORDER,
  CASHFLOW_SCENARIO_SEED,
  CASHFLOW_TRANSFER_ID,
  CASHFLOW_UNCLASSIFIED_ID,
} from "../plan";

describe("Fluxo de Caixa — plano de categorias (planilha CETEM)", () => {
  const plano = CASHFLOW_CATEGORY_PLAN.filter((c) => c.id !== CASHFLOW_TRANSFER_ID);

  it("tem exatamente as 37 categorias da planilha, mais a neutra transferencia_interna", () => {
    expect(plano).toHaveLength(37);
    expect(CASHFLOW_CATEGORY_PLAN).toHaveLength(38);
    expect(new Set(CASHFLOW_CATEGORY_PLAN.map((c) => c.id)).size).toBe(38);
    expect(CASHFLOW_CATEGORY_PLAN.find((c) => c.id === CASHFLOW_TRANSFER_ID)?.kind).toBe("neutro");
  });

  it("entradas: 4 categorias; saídas: 33, distribuídas nos 6 grupos de saída", () => {
    const entradas = plano.filter((c) => c.kind === "entrada").map((c) => c.name);
    expect(entradas).toEqual(["Vendas de Produtos", "Prestação de Serviços", "Receita Financeira", "Outras Receitas"]);
    const porGrupo = (g: string) => plano.filter((c) => c.group === g).map((c) => c.name);
    expect(porGrupo("pessoal")).toEqual(["Folha e Salários", "Pró-labore", "Encargos INSS", "Encargos FGTS", "Benefícios (VR/VT/Saúde)"]);
    expect(porGrupo("operacional")).toEqual(["Aluguel", "Condomínio", "Energia Elétrica", "Água e Esgoto", "Internet e Telefonia", "Fornecedores", "Materiais e Equipamentos", "Frete e Logística"]);
    expect(porGrupo("tributos")).toEqual(["Simples Nacional / DAS", "IRPJ", "CSLL", "PIS / COFINS", "ISS", "ICMS", "Tributos Municipais"]);
    expect(porGrupo("financeiro")).toEqual(["Tarifas Bancárias", "Juros e Multas", "Empréstimos e Financiamentos", "Cartão de Crédito"]);
    expect(porGrupo("crescimento")).toEqual(["Marketing e Publicidade", "Software e Assinaturas", "Consultorias e Contabilidade", "Treinamento e Certificações"]);
    expect(porGrupo("outras")).toEqual(["Manutenção", "Seguros", "Combustível e Deslocamento", "Viagens e Hospedagem", "A Classificar"]);
    expect(CASHFLOW_EXPENSE_GROUPS).toEqual(["pessoal", "operacional", "tributos", "financeiro", "crescimento", "outras"]);
    expect(CASHFLOW_GROUP_ORDER).toHaveLength(8);
  });

  it("fixo/variável segue a planilha", () => {
    const fixos = plano.filter((c) => c.classification === "fixo").map((c) => c.id).sort();
    expect(fixos).toEqual(
      [
        "folha_salarios", "pro_labore", "encargos_inss", "encargos_fgts", "beneficios",
        "aluguel", "condominio", "internet_telefonia", "tributos_municipais",
        "tarifas_bancarias", "emprestimos_financiamentos", "software_assinaturas",
        "consultorias_contabilidade", "seguros",
      ].sort()
    );
    expect(plano.filter((c) => c.kind === "entrada").every((c) => c.classification === "variavel")).toBe(true);
  });

  it("ids reservados existem e a ordem é a da planilha", () => {
    expect(plano.find((c) => c.id === CASHFLOW_UNCLASSIFIED_ID)?.group).toBe("outras");
    expect(plano.find((c) => c.id === CASHFLOW_BANK_FEE_ID)?.group).toBe("financeiro");
    expect(CASHFLOW_CATEGORY_PLAN.map((c) => c.sortOrder)).toEqual(CASHFLOW_CATEGORY_PLAN.map((_, i) => i + 1));
  });

  it("cenários da planilha em pontos-base: otimista +15%/0/0, realista 0/0/0, pessimista −20%/+5%/0", () => {
    expect(CASHFLOW_SCENARIO_SEED.map((s) => [s.code, s.revenueAdjustmentBp, s.expenseAdjustmentBp, s.monthlyGrowthBp])).toEqual([
      ["otimista", 1500, 0, 0],
      ["realista", 0, 0, 0],
      ["pessimista", -2000, 500, 0],
    ]);
  });
});
