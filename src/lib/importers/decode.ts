/**
 * Decodificação e detecção de formato de arquivos de extrato enviados por upload.
 *
 * Bancos brasileiros exportam OFX/CSV com frequência em ISO-8859-1/Windows-1252
 * (acentos quebram se lidos como UTF-8). Estratégia: UTF-8 estrito primeiro;
 * se os bytes não formarem UTF-8 válido, decodifica como Windows-1252.
 * Funções puras — testáveis sem navegador nem Next.
 */

export const MAX_STATEMENT_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

export type StatementEncoding = "utf-8" | "windows-1252";
export type StatementFormat = "ofx" | "csv";

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function stripUtf8Bom(data: Uint8Array): Uint8Array {
  const hasBom =
    data.length >= 3 && UTF8_BOM.every((byte, index) => data[index] === byte);
  return hasBom ? data.subarray(3) : data;
}

/** Decodifica os bytes do arquivo: UTF-8 estrito, com fallback Windows-1252. */
export function decodeStatementBuffer(data: Uint8Array): {
  content: string;
  encoding: StatementEncoding;
} {
  const bytes = stripUtf8Bom(data);
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    };
  } catch {
    // windows-1252 é superconjunto prático do ISO-8859-1 usado pelos bancos.
    return {
      content: new TextDecoder("windows-1252").decode(bytes),
      encoding: "windows-1252",
    };
  }
}

/**
 * Detecta o formato do extrato. Prioridade: conteúdo (assinatura OFX vale mais
 * que extensão errada) → extensão do arquivo → heurística de CSV tabular.
 * Retorna null quando não dá para afirmar com segurança.
 */
export function detectStatementFormat(params: {
  filename?: string;
  content: string;
}): StatementFormat | null {
  const { filename, content } = params;
  const head = content.slice(0, 4096);

  if (/OFXHEADER|<OFX[\s>]/i.test(head)) return "ofx";

  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "ofx") return "ofx";
  if (ext === "csv") return "csv";

  // Heurística CSV: primeiras linhas não vazias compartilham um separador tabular.
  const lines = head
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
  if (lines.length >= 2) {
    for (const separator of [";", ",", "\t"]) {
      if (lines.every((line) => line.includes(separator))) return "csv";
    }
  }
  return null;
}
