import { describe, expect, it } from "vitest";
import type { CategoryCandidate } from "@/core/ai";
import { ValidationError } from "@/core/errors";
import { AnthropicClassifier, DEFAULT_ANTHROPIC_MODEL, redactSensitive } from "../anthropic";
import { buildAi } from "../registry";

const CANDIDATES: CategoryCandidate[] = [
  { id: "cat_energia", name: "Energia elétrica", kind: "expense" },
  { id: "cat_vendas", name: "Vendas de Mercadorias", kind: "income" },
];

function apiResponse(text: string, status = 200): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetch falso que captura a requisição e devolve a resposta programada. */
function fakeFetch(reply: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fn, calls };
}

describe("anthropic / redação LGPD", () => {
  it("mascara CNPJ, CPF, e-mail e sequências longas de dígitos", () => {
    expect(redactSensitive("NF 11.222.333/0001-44 do fornecedor")).toBe(
      "NF [CNPJ] do fornecedor"
    );
    expect(redactSensitive("cliente 123.456.789-09 pagou")).toBe("cliente [CPF] pagou");
    expect(redactSensitive("contato financeiro@beta.com.br")).toBe("contato [EMAIL]");
    expect(redactSensitive("conta 1234567 ag 0001")).toBe("conta [NUM] ag 0001");
    // Dígitos curtos (datas, parcelas) sobrevivem.
    expect(redactSensitive("parcela 2/12 de 2026")).toBe("parcela 2/12 de 2026");
  });
});

describe("anthropic / chamada e validação determinística", () => {
  it("monta a requisição correta (modelo, temperatura 0, descrição redigida) e aceita id da lista", async () => {
    const { fn, calls } = fakeFetch(
      apiResponse('{"categoryId": "cat_energia", "confidence": 0.97, "rationale": "Conta de luz."}')
    );
    const classifier = new AnthropicClassifier({ apiKey: "sk-teste", fetchFn: fn });

    const suggestion = await classifier.suggestCategory(
      "Conta de energia CPF 123.456.789-09",
      CANDIDATES
    );

    expect(classifier.provider).toBe("anthropic");
    expect(suggestion.categoryId).toBe("cat_energia");
    // Teto de confiança: sugestão de IA nunca passa de 0.9.
    expect(suggestion.confidence).toBe(0.9);
    expect(suggestion.rationale).toContain("IA (anthropic");
    expect(suggestion.rationale).toContain("Conta de luz.");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-teste");
    expect(headers["anthropic-version"]).toBeTruthy();
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.temperature).toBe(0);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain("cat_energia");
    expect(prompt).toContain("[CPF]"); // redigido ANTES do envio
    expect(prompt).not.toContain("123.456.789-09");
  });

  it("id fora da lista fechada é rejeitado → degrada para a heurística com motivo declarado", async () => {
    const { fn } = fakeFetch(
      apiResponse('{"categoryId": "cat_inventada", "confidence": 0.9, "rationale": "x"}')
    );
    const classifier = new AnthropicClassifier({ apiKey: "sk-teste", fetchFn: fn });

    const suggestion = await classifier.suggestCategory("Conta de energia elétrica", CANDIDATES);
    // Heurística local encontra "energia" nas candidatas.
    expect(suggestion.categoryId).toBe("cat_energia");
    expect(suggestion.confidence).toBe(0.7);
    expect(suggestion.rationale).toContain("indisponível");
    expect(suggestion.rationale).toContain("heurística local");
  });

  it("erro HTTP e resposta sem JSON degradam sem quebrar (e sem vazar a chave)", async () => {
    for (const reply of [apiResponse("desculpe, não sei"), apiResponse("{}", 500)]) {
      const { fn } = fakeFetch(reply);
      const classifier = new AnthropicClassifier({ apiKey: "sk-secreta", fetchFn: fn });
      const suggestion = await classifier.suggestCategory("Venda pedido 42", CANDIDATES);
      expect(suggestion.categoryId).toBe("cat_vendas"); // heurística
      expect(suggestion.rationale).not.toContain("sk-secreta");
    }
    const { fn } = fakeFetch(new Error("rede caiu"));
    const classifier = new AnthropicClassifier({ apiKey: "sk-secreta", fetchFn: fn });
    const suggestion = await classifier.suggestCategory("Frete de mercadoria", CANDIDATES);
    expect(suggestion.rationale).toContain("indisponível");
    expect(suggestion.rationale).not.toContain("sk-secreta");
  });

  it('aceita "null" como nenhuma categoria (sem inventar id)', async () => {
    const { fn } = fakeFetch(
      apiResponse('{"categoryId": null, "confidence": 0.3, "rationale": "Ambíguo."}')
    );
    const classifier = new AnthropicClassifier({ apiKey: "sk-teste", fetchFn: fn });
    const suggestion = await classifier.suggestCategory("Lançamento genérico", CANDIDATES);
    expect(suggestion.categoryId).toBeUndefined();
    expect(suggestion.confidence).toBe(0.3);
  });
});

describe("anthropic / seleção por env (buildAi)", () => {
  it("default é a heurística mock; anthropic exige chave (falha alto); provedor desconhecido rejeitado", () => {
    expect(buildAi({}).provider).toBe("mock");
    expect(buildAi({ AI_PROVIDER: "mock" }).provider).toBe("mock");
    expect(() => buildAi({ AI_PROVIDER: "anthropic" })).toThrow(ValidationError);
    expect(() => buildAi({ AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(buildAi({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }).provider).toBe(
      "anthropic"
    );
    expect(() => buildAi({ AI_PROVIDER: "gemini" })).toThrow(/desconhecido/);
  });
});
