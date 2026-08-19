/**
 * Seleção do provedor de IA por variável de ambiente. Default: heurística
 * local ("mock", claramente identificada). Como nas integrações, um provedor
 * declarado mas mal configurado falha ALTO na inicialização — o mock nunca é
 * um fallback silencioso de CONFIGURAÇÃO (a degradação por chamada, quando a
 * API real falha em runtime, é explícita na justificativa da sugestão).
 */

import { HeuristicClassifier, type AiClassifier } from "@/core/ai";
import { ValidationError } from "@/core/errors";
import { AnthropicClassifier } from "./anthropic";

export type AiEnv = Record<string, string | undefined>;

export function buildAi(env: AiEnv = process.env): AiClassifier {
  const provider = (env.AI_PROVIDER ?? "mock").toLowerCase();
  if (provider === "mock") return new HeuristicClassifier();
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ValidationError(
        'AI_PROVIDER="anthropic" exige ANTHROPIC_API_KEY definida; configure a chave ou use "mock".'
      );
    }
    return new AnthropicClassifier({ apiKey, model: env.ANTHROPIC_MODEL });
  }
  throw new ValidationError(
    `AI_PROVIDER="${provider}" desconhecido — use "mock" ou "anthropic".`
  );
}
