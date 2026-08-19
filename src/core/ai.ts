/**
 * IA auxiliar — usada APENAS para classificação, explicação e recomendação.
 * Nunca é fonte oficial de dados financeiros nem decide permissões/pagamentos.
 *
 * MVP: implementação heurística determinística ("mock", claramente identificada).
 * Produção: adaptador para um provedor LLM implementando esta mesma interface
 * (plugável via AI_PROVIDER), sempre com validação determinística por cima.
 */

export interface CategoryCandidate {
  id: string;
  name: string;
  kind: "income" | "expense";
}

export interface ClassificationSuggestion {
  categoryId?: string;
  confidence: number; // 0..1
  rationale: string;
}

export interface ReportNarrativeInput {
  reportType: "daily_summary" | "monthly_close" | "executive_overview";
  /** Rótulo do período em pt-BR (ex.: "18/08/2026", "agosto/2026"). */
  periodLabel: string;
  /** Fatos DETERMINÍSTICOS já formatados (rótulo + valor); a IA não calcula nada. */
  facts: Array<{ label: string; value: string }>;
  risks: string[];
  recommendations: string[];
}

export interface ReportNarrative {
  text: string;
  /** Provedor que gerou o texto — exibido na UI para transparência. */
  provider: string;
}

export interface AiClassifier {
  /** Identificação do provedor — exibida na UI para transparência ("mock" no MVP). */
  readonly provider: string;
  suggestCategory(
    description: string,
    candidates: CategoryCandidate[]
  ): Promise<ClassificationSuggestion>;
  /**
   * Resumo narrativo de um relatório A PARTIR dos fatos determinísticos já
   * calculados — a IA nunca produz números novos; os oficiais são os do
   * relatório. Implementações degradam para texto determinístico em falha.
   */
  narrateReport(input: ReportNarrativeInput): Promise<ReportNarrative>;
}

/**
 * Classificador heurístico determinístico por palavras-chave.
 * Serve de fallback e de baseline de testes; identifica-se como "mock".
 */
export class HeuristicClassifier implements AiClassifier {
  readonly provider = "mock";

  private static KEYWORDS: Array<{ pattern: RegExp; categoryHint: string }> = [
    { pattern: /alug|loca[cç][aã]o/i, categoryHint: "aluguel" },
    { pattern: /energia|luz|eletric/i, categoryHint: "energia" },
    { pattern: /internet|telefon|telecom/i, categoryHint: "telecom" },
    { pattern: /sal[aá]rio|folha|pr[oó]-labore|inss|fgts/i, categoryHint: "pessoal" },
    { pattern: /imposto|tribut|das|darf|iss|icms/i, categoryHint: "impostos" },
    { pattern: /frete|log[ií]stica|transporte/i, categoryHint: "frete" },
    { pattern: /marketing|an[uú]ncio|ads|publicidade/i, categoryHint: "marketing" },
    { pattern: /material|insumo|mercadoria|fornecedor/i, categoryHint: "insumos" },
    { pattern: /venda|pedido|nf|fatura|servi[cç]o/i, categoryHint: "vendas" },
    { pattern: /tarifa|banc[aá]ri|juros|iof/i, categoryHint: "tarifas" },
    { pattern: /software|assinatura|licen[cç]a|saas/i, categoryHint: "software" },
  ];

  async suggestCategory(
    description: string,
    candidates: CategoryCandidate[]
  ): Promise<ClassificationSuggestion> {
    for (const { pattern, categoryHint } of HeuristicClassifier.KEYWORDS) {
      if (!pattern.test(description)) continue;
      const match = candidates.find((c) => c.name.toLowerCase().includes(categoryHint));
      if (match) {
        return {
          categoryId: match.id,
          confidence: 0.7,
          rationale: `Heurística (mock): descrição contém padrão "${pattern.source}" associado a "${match.name}".`,
        };
      }
    }
    return {
      categoryId: undefined,
      confidence: 0.2,
      rationale: "Heurística (mock): nenhum padrão conhecido na descrição; revisar manualmente.",
    };
  }

  /** Narrativa determinística por template — mesma entrada, mesmo texto. */
  async narrateReport(input: ReportNarrativeInput): Promise<ReportNarrative> {
    const title = REPORT_TITLES[input.reportType];
    const factsPart = input.facts
      .slice(0, 6)
      .map((f) => `${f.label} ${f.value}`)
      .join("; ");
    const risksPart =
      input.risks.length > 0
        ? ` Pontos de atenção: ${input.risks.length} risco(s) identificado(s), sendo o primeiro: ${input.risks[0]}`
        : " Nenhum risco identificado.";
    const recsPart =
      input.recommendations.length > 0
        ? ` Há ${input.recommendations.length} recomendação(ões) sugerida(s).`
        : "";
    return {
      text: `${title} de ${input.periodLabel} — ${factsPart}.${risksPart}${recsPart}`,
      provider: this.provider,
    };
  }
}

const REPORT_TITLES: Record<ReportNarrativeInput["reportType"], string> = {
  daily_summary: "Resumo do dia",
  monthly_close: "Fechamento do mês",
  executive_overview: "Visão executiva",
};
