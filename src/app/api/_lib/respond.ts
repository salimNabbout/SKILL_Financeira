/**
 * Helpers de resposta HTTP padronizada da API v1.
 * Envelopes: sucesso `{ data }`, erro `{ error: { code, message } }`.
 *
 * Este módulo NÃO importa nada do Next (testável em Node puro).
 * LGPD/segurança: nunca vaza stack trace, passwordHash nem dados bancários crus.
 */

import { ZodError } from "zod";
import { DomainError } from "@/core/errors";
import type { Company, User } from "@/core/entities";

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export function json<T>(data: T, status = 200): Response {
  return Response.json({ data }, { status });
}

export function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Mapeia códigos de DomainError para status HTTP. Códigos desconhecidos → 500. */
export function statusForErrorCode(code: string): number {
  switch (code) {
    case "validation_error":
    case "invalid_input":
      return 400;
    case "unauthorized":
    case "invalid_credentials":
      return 401;
    case "permission_denied":
    case "segregation_of_duties":
      return 403;
    case "not_found":
      return 404;
    default:
      return 500;
  }
}

/**
 * Converte qualquer erro em resposta HTTP padronizada.
 * Erros não tipados viram 500 genérico — a mensagem original NUNCA é exposta
 * (pode conter caminhos, SQL ou dados pessoais).
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    return jsonError(error.code, error.message, statusForErrorCode(error.code));
  }
  if (error instanceof ZodError) {
    const detail = error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    return jsonError("validation_error", `Entrada inválida: ${detail}`, 400);
  }
  return jsonError("internal_error", "Erro interno do servidor.", 500);
}

// ---------------------------------------------------------------------------
// Sanitização (LGPD) e mascaramento
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

/** Remove o passwordHash (e qualquer campo não listado) antes de responder. */
export function publicUser(user: User): PublicUser {
  return { id: user.id, name: user.name, email: user.email, active: user.active };
}

export interface PublicCompany {
  id: string;
  name: string;
  legalName?: string;
  cnpj: string;
  timezone: string;
  defaultCurrency: string;
  active: boolean;
}

/** Empresa sem o blob de config (políticas internas não fazem parte do contrato público). */
export function publicCompany(company: Company): PublicCompany {
  return {
    id: company.id,
    name: company.name,
    legalName: company.legalName,
    cnpj: company.cnpj,
    timezone: company.timezone,
    defaultCurrency: company.defaultCurrency,
    active: company.active,
  };
}

/**
 * Mascara dado sensível (conta bancária, chave PIX): mantém apenas os 4 últimos
 * caracteres. Valores curtos são totalmente mascarados. Nunca armazenamos nem
 * devolvemos o valor original.
 */
export function maskSensitive(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}
