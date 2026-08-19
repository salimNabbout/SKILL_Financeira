/**
 * MOLDE de adaptador REAL da porta ChargeProvider (cobrança Pix/boleto).
 *
 * Este arquivo é um ESQUELETO, não um provedor funcional: as chamadas HTTP são
 * placeholders com TODOs. Copie-o para `src/integrations/providers/<psp>.ts`,
 * ajuste o mapeamento de request/response para a API do seu PSP e registre-o
 * em `src/integrations/registry.ts` (ver o TODO de registro no fim deste arquivo).
 *
 * Padrão a seguir (igual aos mocks):
 *  - implementa a interface da porta (ChargeProvider) — a camada de negócio não muda;
 *  - expõe `provider` com o nome do PSP (aparece nas respostas/telas);
 *  - lê credenciais de variáveis de ambiente (NUNCA hardcode);
 *  - falha ALTO na construção se a configuração estiver ausente
 *    (o registry já garante que "mock nunca é fallback silencioso").
 *
 * IMPORTANTE — peça que NÃO existe no mock: confirmação de pagamento.
 * `createCharge` só EMITE o código. Quando o cliente paga, o PSP notifica via
 * WEBHOOK. É preciso uma rota (ex.: POST /api/v1/webhooks/charges) que valide a
 * assinatura do PSP e dispare a baixa (register_receipt). Ver o bloco WEBHOOK
 * abaixo e a seção correspondente em docs/DEPLOY.md.
 */

import type { ISODate } from "@/core/dates";
import { ValidationError } from "@/core/errors";
import type { ChargeProvider, ChargeResult } from "@/core/integrations";

/** Configuração lida do ambiente. Ajuste os nomes às env do seu PSP. */
export interface ExampleChargeConfig {
  /** Base da API do PSP (ex.: https://api.psp.com). */
  baseUrl: string;
  /** Credenciais — o formato varia por PSP (API key, OAuth client id/secret...). */
  apiKey: string;
  /** Timeout das chamadas HTTP em ms (default 10s). */
  timeoutMs?: number;
}

/** Lê e valida a configuração a partir de env. Falha ALTO se algo faltar. */
export function readExampleChargeConfig(
  env: Record<string, string | undefined> = process.env
): ExampleChargeConfig {
  const baseUrl = env.CHARGES_PSP_BASE_URL;
  const apiKey = env.CHARGES_PSP_API_KEY;
  // TODO: adicione aqui as demais credenciais que seu PSP exigir
  //       (ex.: CHARGES_PSP_CLIENT_ID / _CLIENT_SECRET, certificado mTLS, etc.).
  if (!baseUrl || !apiKey) {
    throw new ValidationError(
      "INTEGRATION_CHARGES real exige CHARGES_PSP_BASE_URL e CHARGES_PSP_API_KEY definidas."
    );
  }
  const timeoutMs = env.CHARGES_PSP_TIMEOUT_MS ? Number(env.CHARGES_PSP_TIMEOUT_MS) : undefined;
  return { baseUrl, apiKey, timeoutMs };
}

export class ExampleChargeProvider implements ChargeProvider {
  /** Nome do provedor — aparece nas respostas e telas. Troque pelo nome real. */
  readonly provider = "example-psp";

  private readonly config: ExampleChargeConfig;

  constructor(config: ExampleChargeConfig) {
    this.config = config;
  }

  async createCharge(params: {
    kind: "pix" | "boleto";
    amountCents: number;
    dueDate: ISODate;
    customerName: string;
    customerDocument?: string;
    receivableId: string;
  }): Promise<ChargeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      // TODO: mapeie `params` para o corpo que a API do PSP espera. Exemplos de
      //       campos comuns: valor (frequentemente em centavos ou em reais com
      //       2 casas — CONFIRME a unidade do seu PSP), vencimento, dados do
      //       pagador, e um identificador seu para reconciliar depois — use
      //       params.receivableId como referência externa (idempotência!).
      const requestBody = {
        type: params.kind, // TODO: alguns PSPs separam endpoints de pix e boleto
        amount: params.amountCents, // TODO: confirme centavos vs. reais
        due_date: params.dueDate,
        payer: {
          name: params.customerName,
          document: params.customerDocument,
        },
        external_reference: params.receivableId, // reconciliação e idempotência
      };

      // TODO: ajuste o path e o esquema de autenticação ao seu PSP.
      const response = await fetch(`${this.config.baseUrl}/v1/charges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          // Idempotência do lado do PSP (evita cobrança duplicada em retry):
          "idempotency-key": params.receivableId,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new ValidationError(
          `PSP retornou ${response.status} ao criar cobrança do título ${params.receivableId}: ${detail.slice(0, 300)}`
        );
      }

      // TODO: mapeie a resposta do PSP para ChargeResult. Os nomes abaixo são
      //       ILUSTRATIVOS — troque pelos campos reais da API.
      const data = (await response.json()) as {
        id: string;
        // Pix copia-e-cola OU linha digitável do boleto, conforme kind:
        code: string;
        expires_at: string;
      };

      return {
        provider: this.provider,
        chargeId: data.id,
        kind: params.kind,
        code: data.code,
        expiresAt: data.expires_at.slice(0, 10) as ISODate, // "YYYY-MM-DD"
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * COMO REGISTRAR (em src/integrations/registry.ts)
 * ---------------------------------------------------------------------------
 * Substitua a chamada `assertMockOnly("INTEGRATION_CHARGES", ...)` por uma
 * seleção que aceite seu provedor. Esboço:
 *
 *   function buildChargeProvider(env): ChargeProvider {
 *     const selected = (env.INTEGRATION_CHARGES ?? "mock").toLowerCase();
 *     if (selected === "mock") return new MockChargeProvider();
 *     if (selected === "example-psp") {
 *       return new ExampleChargeProvider(readExampleChargeConfig(env));
 *     }
 *     throw new ValidationError(`INTEGRATION_CHARGES="${selected}" não suportado.`);
 *   }
 *
 * E em buildIntegrations(), troque `charges: new MockChargeProvider()` por
 * `charges: buildChargeProvider(env)`. Os demais provedores seguem em mock até
 * receberem o mesmo tratamento.
 *
 * ---------------------------------------------------------------------------
 * WEBHOOK DE CONFIRMAÇÃO DE PAGAMENTO (peça nova, obrigatória p/ baixa automática)
 * ---------------------------------------------------------------------------
 * createCharge só EMITE. A baixa (register_receipt) precisa ser disparada quando
 * o PSP confirmar o pagamento. Crie uma rota, por ex.:
 *
 *   // src/app/api/v1/webhooks/charges/route.ts
 *   export const POST = withErrors(async (req) => {
 *     // 1) VALIDE a assinatura do webhook (HMAC/segredo do PSP) ANTES de confiar
 *     //    no corpo — sem isso, qualquer um poderia forjar um "pago".
 *     // 2) Extraia external_reference (o receivableId enviado em createCharge) e
 *     //    o valor/data pagos.
 *     // 3) Dispare a baixa idempotente: o fluxo/skill contas_a_receber com
 *     //    action register_receipt (mesmo caminho da baixa manual). Idempotência
 *     //    é essencial: PSPs reenviam webhooks.
 *     // 4) Responda 200 rápido; processe pesado de forma assíncrona se preciso.
 *   });
 *
 * Segurança: a rota de webhook é PÚBLICA (o PSP chama de fora) — ela NÃO usa a
 * sessão por cookie; a autenticação é a assinatura do PSP. Garanta que o
 * middleware/CSRF não a bloqueie (o matcher atual cobre /api/v1/** — avalie
 * isentar o path de webhook ou validar por assinatura em vez de Origin).
 */
