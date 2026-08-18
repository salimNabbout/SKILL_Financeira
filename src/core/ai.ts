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

export interface AiClassifier {
  /** Identificação do provedor — exibida na UI para transparência ("mock" no MVP). */
  readonly provider: string;
  suggestCategory(
    description: string,
    candidates: CategoryCandidate[]
  ): Promise<ClassificationSuggestion>;
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
}
