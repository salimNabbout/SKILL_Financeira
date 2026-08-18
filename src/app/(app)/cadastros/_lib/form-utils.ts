/**
 * Utilitários puros de formulário compartilhados pelas páginas do grupo B.
 * Sem dependência de Next/server — testáveis em Node puro.
 */

import { isISODate, type ISODate } from "@/core/dates";
import { ValidationError } from "@/core/errors";

/**
 * Converte um valor monetário digitado em pt-BR para centavos (inteiro).
 * Aceita "1.234,56", "1234,56", "R$ 2.500,00", "1000", "10.5", "1.234" (milhar)
 * e valores negativos ("-100,00"). Nunca usa float: aritmética sobre strings.
 */
export function parseBRLToCents(raw: string): number {
  let s = raw
    .trim()
    .replace(/ /g, " ")
    .replace(/R\$\s*/gi, "")
    .replace(/\s+/g, "");
  if (!s) throw new ValidationError("Informe um valor monetário.");

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s)) {
    throw new ValidationError(`Valor monetário inválido: "${raw}". Use o formato 1.234,56.`);
  }

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let intPart: string;
  let decPart: string;

  if (lastComma >= 0 && lastDot >= 0) {
    // O separador que aparece por último é o decimal; o outro é milhar.
    const sepIdx = Math.max(lastComma, lastDot);
    intPart = s.slice(0, sepIdx).replace(/[.,]/g, "");
    decPart = s.slice(sepIdx + 1);
  } else if (lastComma >= 0) {
    if (s.indexOf(",") !== lastComma) {
      throw new ValidationError(`Valor monetário inválido: "${raw}". Use apenas uma vírgula decimal.`);
    }
    intPart = s.slice(0, lastComma);
    decPart = s.slice(lastComma + 1);
  } else if (lastDot >= 0) {
    const afterLastDot = s.slice(lastDot + 1);
    const dotCount = s.split(".").length - 1;
    if (dotCount > 1 || afterLastDot.length === 3) {
      // Pontos como separador de milhar: "1.234" ou "1.234.567".
      intPart = s.replace(/\./g, "");
      decPart = "";
    } else {
      intPart = s.slice(0, lastDot);
      decPart = afterLastDot;
    }
  } else {
    intPart = s;
    decPart = "";
  }

  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(decPart) || (intPart === "" && decPart === "")) {
    throw new ValidationError(`Valor monetário inválido: "${raw}". Use o formato 1.234,56.`);
  }
  if (decPart.length > 2) {
    throw new ValidationError(
      `Valor monetário inválido: "${raw}". Use vírgula para separar os centavos (ex.: 1.234,56).`
    );
  }

  const cents = Number(intPart || "0") * 100 + Number(decPart.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) {
    throw new ValidationError(`Valor monetário fora do intervalo suportado: "${raw}".`);
  }
  return negative ? -cents : cents;
}

/** Converte "dd/mm/aaaa" para ISODate, validando a existência da data. */
export function brDateToISO(raw: string): ISODate {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new ValidationError(`Data inválida: "${raw}". Use o formato dd/mm/aaaa.`);
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  if (!isISODate(iso)) throw new ValidationError(`Data inexistente: "${raw}".`);
  return iso;
}

export interface InstallmentSpec {
  dueDate: ISODate;
  amountCents: number;
}

/**
 * Interpreta o plano de parcelas no formato "dd/mm/aaaa=valor;dd/mm/aaaa=valor".
 * Retorna [] para entrada vazia (sem parcelas explícitas).
 */
export function parseInstallmentsSpec(raw: string): InstallmentSpec[] {
  const items = raw
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return items.map((item) => {
    const eq = item.indexOf("=");
    if (eq < 0) {
      throw new ValidationError(
        `Parcela inválida: "${item}". Use o formato dd/mm/aaaa=valor; dd/mm/aaaa=valor.`
      );
    }
    const dueDate = brDateToISO(item.slice(0, eq));
    const amountCents = parseBRLToCents(item.slice(eq + 1));
    if (amountCents <= 0) {
      throw new ValidationError(`Parcela inválida: "${item}". O valor deve ser positivo.`);
    }
    return { dueDate, amountCents };
  });
}

/**
 * Máscara obrigatória de número de conta: apenas os 4 últimos dígitos são
 * mantidos; o número completo NUNCA é persistido.
 */
export function maskAccountNumber(fullNumber: string): string {
  const digits = fullNumber.replace(/\D/g, "");
  if (digits.length < 4) {
    throw new ValidationError("Número de conta muito curto: informe ao menos 4 dígitos.");
  }
  return `****-${digits.slice(-4)}`;
}

/** Lê um campo string obrigatório de FormData ("" se ausente). */
export function fdString(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Lê um campo string opcional de FormData (undefined se vazio). */
export function fdOptional(fd: FormData, key: string): string | undefined {
  const v = fdString(fd, key);
  return v === "" ? undefined : v;
}

/** Extrai mensagem de erro legível (pt-BR) de exceções capturadas em actions. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mensagem de erro de um fluxo do orquestrador que terminou "failed". */
export function flowErrorMessage(response: {
  consolidated: { alerts: Array<{ severity: string; message: string }> };
}): string {
  const alerts = response.consolidated.alerts;
  return (
    alerts.find((a) => a.severity === "critical")?.message ??
    alerts[0]?.message ??
    "Falha na execução do fluxo."
  );
}

/** Mensagem de erro de um SkillResult com status "error". */
export function skillErrorMessage(result: {
  alerts: Array<{ severity: string; message: string }>;
}): string {
  return (
    result.alerts.find((a) => a.severity === "critical")?.message ??
    result.alerts[0]?.message ??
    "Falha na execução da skill."
  );
}
