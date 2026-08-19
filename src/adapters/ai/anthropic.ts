/**
 * Adaptador REAL de IA (API Anthropic) atrás da interface AiClassifier.
 *
 * Governança (inalterada em relação ao mock):
 * - IA APENAS sugere classificação com justificativa — nunca é fonte de dados
 *   nem decide permissões/pagamentos; o usuário confirma na criação do título.
 * - Validação determinística por cima: a resposta só é aceita se apontar uma
 *   categoria da LISTA FECHADA de candidatas; qualquer outra coisa (erro de
 *   rede, JSON inválido, id desconhecido) degrada para a heurística local —
 *   a skill nunca quebra por causa da IA.
 * - LGPD: a descrição é REDIGIDA antes do envio (CPF/CNPJ, e-mails e
 *   sequências longas de dígitos viram máscaras); a chave nunca aparece em
 *   erros ou justificativas.
 *
 * Sem SDK: chamada direta à Messages API com fetch nativo (injetável em teste).
 */

import {
  HeuristicClassifier,
  type AiClassifier,
  type CategoryCandidate,
  type ClassificationSuggestion,
  type ReportNarrative,
  type ReportNarrativeInput,
} from "@/core/ai";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
/** Teto de confiança de qualquer sugestão de IA — sugestão nunca vira certeza. */
const AI_CONFIDENCE_CAP = 0.9;

/**
 * Redação LGPD antes de enviar texto a terceiros: CNPJ, CPF, e-mails e
 * sequências de 5+ dígitos (contas, telefones, códigos) viram máscaras.
 * A ordem importa: CNPJ antes de CPF antes da máscara genérica de dígitos.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[CNPJ]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .replace(/\d{5,}/g, "[NUM]");
}

export interface AnthropicClassifierOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Injetável para testes determinísticos (default: fetch global). */
  fetchFn?: typeof fetch;
}

export class AnthropicClassifier implements AiClassifier {
  readonly provider = "anthropic";
  private readonly fallback = new HeuristicClassifier();
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: AnthropicClassifierOptions) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async suggestCategory(
    description: string,
    candidates: CategoryCandidate[]
  ): Promise<ClassificationSuggestion> {
    if (candidates.length === 0) {
      return this.degrade(description, candidates, "sem categorias candidatas");
    }
    try {
      const raw = await this.callApi(redactSensitive(description), candidates);
      const parsed = this.parseSuggestion(raw, candidates);
      if (!parsed) {
        return this.degrade(description, candidates, "resposta fora do contrato");
      }
      return parsed;
    } catch (error) {
      // Mensagem curta e sem material sensível (nunca a chave nem o corpo).
      const reason = error instanceof Error ? error.name : "erro desconhecido";
      return this.degrade(description, candidates, `falha na chamada (${reason})`);
    }
  }

  /** Degradação: heurística local, com o motivo declarado na justificativa. */
  private async degrade(
    description: string,
    candidates: CategoryCandidate[],
    reason: string
  ): Promise<ClassificationSuggestion> {
    const heuristic = await this.fallback.suggestCategory(description, candidates);
    return {
      ...heuristic,
      rationale: `IA (anthropic) indisponível — ${reason}; usando heurística local. ${heuristic.rationale}`,
    };
  }

  /**
   * Resumo narrativo dos fatos determinísticos do relatório. Textos livres
   * (riscos/recomendações podem citar clientes) são redigidos antes do envio;
   * falhas degradam para a narrativa determinística local, com o motivo.
   */
  async narrateReport(input: ReportNarrativeInput): Promise<ReportNarrative> {
    const factsList = input.facts.map((f) => `- ${f.label}: ${f.value}`).join("\n");
    const risksList = input.risks.map((r) => `- ${redactSensitive(r)}`).join("\n");
    const recsList = input.recommendations.map((r) => `- ${redactSensitive(r)}`).join("\n");
    const prompt = [
      "Você resume relatórios financeiros de PMEs brasileiras para gestores.",
      "Escreva um parágrafo de 3 a 5 frases em pt-BR, tom objetivo e claro.",
      "REGRA ABSOLUTA: não invente números nem fatos — use SOMENTE os itens listados abaixo; os números oficiais são os do relatório.",
      "Responda apenas com o parágrafo, sem títulos nem marcadores.",
      "",
      `Relatório: ${input.reportType} · Período: ${input.periodLabel}`,
      "Fatos calculados:",
      factsList,
      ...(risksList ? ["Riscos identificados:", risksList] : []),
      ...(recsList ? ["Recomendações determinísticas:", recsList] : []),
    ].join("\n");

    try {
      const text = (await this.callMessages(prompt, 500)).trim();
      if (!text) throw new Error("resposta vazia");
      return { text: text.slice(0, 1500), provider: this.provider };
    } catch (error) {
      const reason = error instanceof Error ? error.name : "erro desconhecido";
      const fallback = await this.fallback.narrateReport(input);
      return {
        text: `[IA indisponível — ${reason}; resumo determinístico local] ${fallback.text}`,
        provider: fallback.provider,
      };
    }
  }

  private async callApi(redactedDescription: string, candidates: CategoryCandidate[]): Promise<string> {
    const list = candidates
      .map((c) => `- id: ${c.id} | nome: ${c.name} | tipo: ${c.kind === "income" ? "receita" : "despesa"}`)
      .join("\n");
    const prompt = [
      "Você classifica lançamentos financeiros de PMEs brasileiras.",
      "Escolha APENAS uma categoria da lista fechada abaixo (ou nenhuma).",
      "Responda SOMENTE com JSON: {\"categoryId\": \"<id da lista ou null>\", \"confidence\": <0 a 1>, \"rationale\": \"<justificativa curta em pt-BR>\"}",
      "",
      "Categorias candidatas:",
      list,
      "",
      `Descrição do lançamento (dados sensíveis já redigidos): "${redactedDescription}"`,
    ].join("\n");
    return this.callMessages(prompt, 300);
  }

  private async callMessages(prompt: string, maxTokens: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = payload.content?.find((c) => typeof c.text === "string")?.text;
      if (!text) throw new Error("resposta sem texto");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Validação determinística: só aceita id da lista fechada; confiança com teto. */
  private parseSuggestion(
    raw: string,
    candidates: CategoryCandidate[]
  ): ClassificationSuggestion | null {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    let parsed: { categoryId?: unknown; confidence?: unknown; rationale?: unknown };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
    const categoryId =
      typeof parsed.categoryId === "string" && parsed.categoryId !== "null"
        ? parsed.categoryId
        : undefined;
    if (categoryId !== undefined && !candidates.some((c) => c.id === categoryId)) {
      return null; // id fora da lista fechada — inaceitável
    }
    const confidenceRaw = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
    const confidence = Math.min(AI_CONFIDENCE_CAP, Math.max(0, confidenceRaw));
    const rationale =
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim()
        : "sem justificativa fornecida";
    return {
      categoryId,
      confidence,
      rationale: `IA (anthropic, ${this.model}): ${rationale}`,
    };
  }
}
