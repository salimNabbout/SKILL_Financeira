/**
 * Linhas da tabela do DRE gerencial — função pura, separada da página para
 * ser testável. As linhas subtrativas (deduções, custos, despesas) são
 * exibidas com sinal negativo; zero continua zero (nunca −0, que o
 * formatador pt-BR renderiza como "-R$ 0,00").
 */

// Forma defensiva do contrato de controladoria_indicadores (escrita em paralelo).
export interface DreStatementView {
  receitaBrutaCents?: number;
  deducoesCents?: number;
  receitaLiquidaCents?: number;
  custosCents?: number;
  lucroBrutoCents?: number;
  despesasOperacionaisCents?: number;
  ebitdaCents?: number;
  resultadoFinanceiroCents?: number;
  resultadoCents?: number;
  outrasCents?: number;
}

export interface DreRow {
  label: string;
  valueCents: number | undefined;
  /** Linha subtrativa exibida com sinal negativo e indentação. */
  indent?: boolean;
  subtotal?: boolean;
  muted?: boolean;
}

/** Sinal invertido para exibição; zero permanece +0 (Object.is(-0, 0) é false, e Intl mostra o sinal). */
export function negForDisplay(v: number | undefined): number | undefined {
  if (typeof v !== "number") return undefined;
  return v === 0 ? 0 : -v;
}

export function buildRows(d: DreStatementView | undefined): DreRow[] {
  const neg = negForDisplay;
  return [
    { label: "Receita bruta", valueCents: d?.receitaBrutaCents },
    { label: "(-) Deduções e impostos sobre vendas", valueCents: neg(d?.deducoesCents), indent: true },
    { label: "(=) Receita líquida", valueCents: d?.receitaLiquidaCents, subtotal: true },
    { label: "(-) Custos", valueCents: neg(d?.custosCents), indent: true },
    { label: "(=) Lucro bruto", valueCents: d?.lucroBrutoCents, subtotal: true },
    { label: "(-) Despesas operacionais", valueCents: neg(d?.despesasOperacionaisCents), indent: true },
    { label: "(=) EBITDA gerencial", valueCents: d?.ebitdaCents, subtotal: true },
    { label: "(+/-) Resultado financeiro", valueCents: d?.resultadoFinanceiroCents, indent: true },
    { label: "(=) Resultado do período", valueCents: d?.resultadoCents, subtotal: true },
    {
      label: "Outras receitas e despesas (informativo, fora do resultado)",
      valueCents: d?.outrasCents,
      indent: true,
      muted: true,
    },
  ];
}
