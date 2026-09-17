/**
 * Auditoria de fórmulas — DRE (DRE-02/04/06, apresentação). Com deduções,
 * custos ou despesas zerados a tabela mostrava "-R$ 0,00": `-v` de 0 é −0 e
 * o Intl.NumberFormat exibe o sinal. Verificado na cópia dos dados reais
 * (agosto/2026, todas as linhas zeradas por falta de categoria nos títulos).
 */

import { describe, expect, it } from "vitest";
import { formatBRL } from "@/core/money";
import { buildRows, negForDisplay } from "../_lib/dre-rows";

describe("DRE — linhas subtrativas", () => {
  it("zero exibe R$ 0,00 (nunca -R$ 0,00); valores positivos aparecem negativos; ausente vira '—'", () => {
    expect(Object.is(negForDisplay(0), 0)).toBe(true);
    expect(negForDisplay(1_234)).toBe(-1_234);
    expect(negForDisplay(undefined)).toBeUndefined();
    expect(formatBRL(negForDisplay(0)!).replace(/ /g, " ")).toBe("R$ 0,00");
    expect(formatBRL(negForDisplay(1_234)!).replace(/ /g, " ")).toBe("-R$ 12,34");
  });

  it("monta as 10 linhas na ordem do demonstrativo, invertendo só deduções, custos e despesas operacionais", () => {
    const rows = buildRows({
      receitaBrutaCents: 1_000,
      deducoesCents: 0,
      receitaLiquidaCents: 1_000,
      custosCents: 300,
      lucroBrutoCents: 700,
      despesasOperacionaisCents: 200,
      ebitdaCents: 500,
      resultadoFinanceiroCents: -50,
      resultadoCents: 450,
      outrasCents: 99,
    });
    expect(rows.map((r) => r.valueCents)).toEqual([1_000, 0, 1_000, -300, 700, -200, 500, -50, 450, 99]);
    expect(Object.is(rows[1].valueCents, 0)).toBe(true);
    expect(rows.filter((r) => r.subtotal).map((r) => r.label)).toEqual([
      "(=) Receita líquida",
      "(=) Lucro bruto",
      "(=) EBITDA gerencial",
      "(=) Resultado do período",
    ]);
  });

  it("sem dados (skill indisponível) todas as linhas ficam sem valor", () => {
    expect(buildRows(undefined).every((r) => r.valueCents === undefined)).toBe(true);
  });
});
