/**
 * Painel por Período — cálculo puro (PNL-01..PNL-07 do relatório de fórmulas).
 * Período: padrão, mês curto, ano inteiro, validação. Agregação: identidades
 * Fixo + Variável + Não classificado = Total Pago, Σ centros + Sem centro =
 * Total Pago, Σ categorias do centro = total do centro; seleção de centro e
 * categoria; base vazia; arredondamento do percentual.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import {
  defaultPeriodInput,
  resolvePeriod,
  SEM_CATEGORIA,
  SEM_CENTRO,
  summarizePaid,
} from "../period-panel";
import type { ExecutedPaymentsGroup } from "../repositories";

describe("Painel por Período — período", () => {
  it("padrão: ano e mês de hoje, do dia 1 ao último dia (setembro tem 30)", () => {
    expect(defaultPeriodInput("2026-09-17")).toEqual({ year: 2026, month: 9, dayFrom: 1, dayTo: 30 });
    expect(defaultPeriodInput("2028-02-10")).toEqual({ year: 2028, month: 2, dayFrom: 1, dayTo: 29 });
  });

  it("mês fechado: inclusivo nas duas pontas, com rótulo pt-BR", () => {
    const p = resolvePeriod({ year: 2026, month: 8, dayFrom: 1, dayTo: 31 });
    expect(p).toMatchObject({ from: "2026-08-01", to: "2026-08-31", daysInMonth: 31, label: "01/08/2026 a 31/08/2026" });
  });

  it("dias além do tamanho do mês são ajustados (31 → 30 em setembro; 31 → 28 em fevereiro)", () => {
    expect(resolvePeriod({ year: 2026, month: 9, dayFrom: 31, dayTo: 31 })).toMatchObject({ dayFrom: 30, dayTo: 30, from: "2026-09-30", to: "2026-09-30" });
    expect(resolvePeriod({ year: 2026, month: 2, dayFrom: 10, dayTo: 31 })).toMatchObject({ dayFrom: 10, dayTo: 28, to: "2026-02-28" });
  });

  it("dias ausentes caem no padrão 1..último; sub-período de 5 a 12", () => {
    expect(resolvePeriod({ year: 2026, month: 12 })).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
    expect(resolvePeriod({ year: 2026, month: 12, dayFrom: 5, dayTo: 12 })).toMatchObject({ from: "2026-12-05", to: "2026-12-12" });
  });

  it("mês 'Todos': ano inteiro, dias ignorados", () => {
    const p = resolvePeriod({ year: 2026, dayFrom: 10, dayTo: 20 });
    expect(p).toMatchObject({ from: "2026-01-01", to: "2026-12-31", label: "01/01/2026 a 31/12/2026" });
    expect(p.month).toBeUndefined();
  });

  it("dia inicial > dia final, mês ou dia inválidos são erros de validação", () => {
    expect(() => resolvePeriod({ year: 2026, month: 9, dayFrom: 20, dayTo: 10 })).toThrow(ValidationError);
    expect(() => resolvePeriod({ year: 2026, month: 13 })).toThrow(ValidationError);
    expect(() => resolvePeriod({ year: 2026, month: 9, dayFrom: 0 })).toThrow(ValidationError);
    expect(() => resolvePeriod({ year: 1800 })).toThrow(ValidationError);
  });
});

const CENTROS = [
  { id: "cc_a", code: "100", name: "Administrativo" },
  { id: "cc_b", code: "200", name: "Comercial" },
];

const GRUPOS: ExecutedPaymentsGroup[] = [
  { costClassification: "fixed", costCenterId: "cc_a", supplierCategory: "Aluguel", totalCents: 5_000, count: 2 },
  { costClassification: "variable", costCenterId: "cc_a", supplierCategory: "Frete", totalCents: 1_000, count: 1 },
  { costClassification: "fixed", costCenterId: "cc_b", supplierCategory: "Aluguel", totalCents: 3_000, count: 1 },
  { costClassification: undefined, costCenterId: "cc_b", supplierCategory: "Frete", totalCents: 700, count: 1 },
  { costClassification: "variable", costCenterId: undefined, supplierCategory: "", totalCents: 300, count: 1 },
];

describe("Painel por Período — agregação dos pagamentos", () => {
  it("totais e identidade Fixo + Variável + Não classificado = Total Pago", () => {
    const s = summarizePaid(GRUPOS, CENTROS);
    expect(s.paidCents).toBe(10_000);
    expect(s.paidCount).toBe(6);
    expect(s.fixedCents).toBe(8_000);
    expect(s.variableCents).toBe(1_300);
    expect(s.unclassifiedCents).toBe(700);
    expect(s.fixedCents + s.variableCents + s.unclassifiedCents).toBe(s.paidCents);
  });

  it("centros com movimento (maior primeiro), 'Sem centro' como faixa própria; Σ centros + Sem centro = Total Pago", () => {
    const s = summarizePaid(GRUPOS, CENTROS);
    expect(s.byCostCenter.map((c) => [c.costCenterId, c.code, c.name, c.totalCents])).toEqual([
      ["cc_a", "100", "Administrativo", 6_000],
      ["cc_b", "200", "Comercial", 3_700],
      [null, "", SEM_CENTRO, 300],
    ]);
    expect(s.byCostCenter.reduce((t, c) => t + c.totalCents, 0)).toBe(s.paidCents);
    // Com "Todos": total do centro = Total Pago; categorias de todos os centros.
    expect(s.selectedCostCenterId).toBeNull();
    expect(s.costCenterTotalCents).toBe(10_000);
    expect(s.categories.map((c) => [c.category, c.totalCents, c.percentOfCenter])).toEqual([
      ["Aluguel", 8_000, 80],
      ["Frete", 1_700, 17],
      [SEM_CATEGORIA, 300, 3],
    ]);
    expect(s.categoryTotalCents).toBe(10_000);
  });

  it("centro selecionado: total do centro e cascata de categorias só desse centro; Σ categorias = total do centro", () => {
    const s = summarizePaid(GRUPOS, CENTROS, { costCenterId: "cc_b" });
    expect(s.costCenterTotalCents).toBe(3_700);
    expect(s.categories.map((c) => [c.category, c.totalCents, c.percentOfCenter])).toEqual([
      ["Aluguel", 3_000, 81.08],
      ["Frete", 700, 18.92],
    ]);
    expect(s.categories.reduce((t, c) => t + c.totalCents, 0)).toBe(s.costCenterTotalCents);
    // Totais gerais não mudam com a seleção (só o gráfico e os 4 totais reagem ao período).
    expect(s.paidCents).toBe(10_000);
  });

  it("categoria selecionada dentro do centro; categoria sem movimento no centro = 0", () => {
    expect(summarizePaid(GRUPOS, CENTROS, { costCenterId: "cc_b", category: "Frete" }).categoryTotalCents).toBe(700);
    expect(summarizePaid(GRUPOS, CENTROS, { costCenterId: "cc_a", category: "Inexistente" }).categoryTotalCents).toBe(0);
    expect(summarizePaid(GRUPOS, CENTROS, { category: "Aluguel" }).categoryTotalCents).toBe(8_000);
  });

  it("centro fora do cadastro é rotulado pelo id; centro sem movimento não aparece", () => {
    const s = summarizePaid([{ costCenterId: "cc_x", totalCents: 1, count: 1 }], CENTROS);
    expect(s.byCostCenter).toEqual([{ costCenterId: "cc_x", code: "cc_x", name: "cc_x", totalCents: 1, count: 1 }]);
  });

  it("base vazia: tudo zero, listas vazias, percentuais sem divisão por zero", () => {
    const s = summarizePaid([], CENTROS, { costCenterId: "cc_a", category: "Aluguel" });
    expect(s).toMatchObject({
      paidCents: 0,
      paidCount: 0,
      fixedCents: 0,
      variableCents: 0,
      unclassifiedCents: 0,
      byCostCenter: [],
      costCenterTotalCents: 0,
      categories: [],
      categoryTotalCents: 0,
    });
  });

  it("percentual do centro arredonda a 2 casas e a soma dos percentuais fica próxima de 100", () => {
    const s = summarizePaid(
      [
        { costCenterId: "cc_a", supplierCategory: "A", totalCents: 1, count: 1 },
        { costCenterId: "cc_a", supplierCategory: "B", totalCents: 1, count: 1 },
        { costCenterId: "cc_a", supplierCategory: "C", totalCents: 1, count: 1 },
      ],
      CENTROS,
      { costCenterId: "cc_a" }
    );
    expect(s.categories.map((c) => c.percentOfCenter)).toEqual([33.33, 33.33, 33.33]);
  });
});
