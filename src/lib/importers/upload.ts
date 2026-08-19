/**
 * Extração de arquivo de extrato de um FormData (upload real na UI e na API).
 * Usa as APIs web File/FormData disponíveis no Node 22 — sem dependências.
 */

import { ValidationError } from "@/core/errors";
import {
  decodeStatementBuffer,
  detectStatementFormat,
  MAX_STATEMENT_FILE_BYTES,
  type StatementEncoding,
  type StatementFormat,
} from "./decode";

export interface StatementUpload {
  content: string;
  format: StatementFormat;
  encoding: StatementEncoding;
  filename?: string;
}

/** Campos aceitos para o arquivo no multipart (UI usa "arquivo"; API aceita ambos). */
const FILE_FIELDS = ["arquivo", "file"] as const;

function pickFile(formData: FormData): File | null {
  for (const field of FILE_FIELDS) {
    const value = formData.get(field);
    if (value instanceof File && value.size > 0) return value;
  }
  return null;
}

/**
 * Resolve o conteúdo e o formato do extrato a partir do FormData:
 * arquivo enviado tem precedência; texto colado (campo "content") é o fallback.
 * format "auto" (ou ausente) aciona a detecção por conteúdo/extensão.
 * Lança ValidationError com mensagem em pt-BR para qualquer entrada inválida.
 */
export async function extractStatementUpload(formData: FormData): Promise<StatementUpload> {
  const requestedFormat = String(formData.get("format") ?? "auto").toLowerCase();
  if (!["auto", "ofx", "csv", "cnab240"].includes(requestedFormat)) {
    throw new ValidationError(`Formato de extrato inválido: ${requestedFormat}.`);
  }

  const file = pickFile(formData);
  let content: string;
  let encoding: StatementEncoding = "utf-8";
  let filename: string | undefined;

  if (file) {
    if (file.size > MAX_STATEMENT_FILE_BYTES) {
      throw new ValidationError(
        `Arquivo excede o limite de ${Math.floor(MAX_STATEMENT_FILE_BYTES / 1024 / 1024)} MB.`
      );
    }
    const decoded = decodeStatementBuffer(new Uint8Array(await file.arrayBuffer()));
    content = decoded.content;
    encoding = decoded.encoding;
    filename = file.name || undefined;
  } else {
    const pasted = formData.get("content");
    content = typeof pasted === "string" ? pasted : "";
    // Mesmo teto do arquivo: o texto colado não pode escapar do limite e virar
    // um vetor de DoS de parsing (regex/char-a-char sobre entrada gigante).
    if (Buffer.byteLength(content, "utf8") > MAX_STATEMENT_FILE_BYTES) {
      throw new ValidationError(
        `Conteúdo excede o limite de ${Math.floor(MAX_STATEMENT_FILE_BYTES / 1024 / 1024)} MB.`
      );
    }
  }

  if (content.trim().length === 0) {
    throw new ValidationError("Envie o arquivo do extrato ou cole o conteúdo exportado pelo banco.");
  }

  const format =
    requestedFormat === "auto"
      ? detectStatementFormat({ filename, content })
      : (requestedFormat as StatementFormat);
  if (!format) {
    throw new ValidationError(
      "Não foi possível detectar o formato do extrato — selecione OFX, CSV ou CNAB240 manualmente."
    );
  }

  return { content, format, encoding, filename };
}
