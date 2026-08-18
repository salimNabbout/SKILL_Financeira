/**
 * Camada HTTP da API v1: autenticação por cookie de sessão + tratamento de erros.
 * A lógica de negócio fica em ./handlers e ./reports (testáveis sem Next);
 * aqui só entra o que depende do runtime do Next (cookies, container singleton).
 */

import type { SessionInfo } from "@/lib/session";
import { getSession } from "@/lib/session";
import type { AppContainer } from "@/lib/container";
import { getContainer } from "@/lib/container";
import { ValidationError } from "@/core/errors";
import { errorResponse, json, jsonError } from "./respond";

export { json, jsonError, errorResponse } from "./respond";

export interface AuthedContext<P> {
  session: SessionInfo;
  container: AppContainer;
  params: P;
}

type RouteExtra<P> = { params: Promise<P> };

/**
 * Envolve um handler autenticado: sem sessão válida → 401; DomainError/Zod →
 * status apropriado; erro inesperado → 500 sem vazar stack. Passa { session,
 * container, params } (params já resolvidos — Promise no Next 15).
 */
export function withAuth<P = Record<string, string>>(
  handler: (req: Request, ctx: AuthedContext<P>) => Promise<Response>
): (req: Request, extra: RouteExtra<P>) => Promise<Response> {
  // O validador de tipos de rota do Next 15 exige o segundo argumento não-opcional;
  // em rotas estáticas ele chega sem params úteis, então o acesso continua defensivo.
  return async (req, extra) => {
    try {
      const session = await getSession();
      if (!session) {
        return jsonError("unauthorized", "Sessão ausente ou expirada. Faça login.", 401);
      }
      const container = await getContainer();
      const params = extra?.params ? await extra.params : ({} as P);
      return await handler(req, { session, container, params });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Variante sem exigência de sessão (login/logout), com o mesmo tratamento de erros. */
export function withErrors(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Lê o corpo JSON; corpo ausente/inválido vira ValidationError (400). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Corpo da requisição deve ser JSON válido.");
  }
}

/** Query string como objeto simples (validação fica nos handlers, via zod). */
export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}
