/**
 * Parser OFX (Open Financial Exchange) tolerante — bancos brasileiros exportam
 * OFX 1.x (SGML), em que elementos-folha NÃO têm tag de fechamento e o header
 * ("OFXHEADER:100...") não é XML. Estratégia: fatiar blocos <STMTTRN> e extrair
 * campos por expressão regular, aceitando valor com ponto OU vírgula decimal.
 * Função pura: nunca lança para conteúdo malformado — linhas inválidas viram
 * warnings e são ignoradas.
 */

import { isISODate, type ISODate } from "@/core/dates";
import {
  parseDecimalToCents,
  type ParsedStatement,
  type StatementTransaction,
} from "./common";

/** Extrai blocos <STMTTRN>…</STMTTRN>; tolera fechamento ausente (corta no próximo bloco). */
function extractTransactionBlocks(content: string): string[] {
  return content
    .split(/<STMTTRN>/i)
    .slice(1)
    .map((chunk) => chunk.split(/<\/STMTTRN>/i)[0]);
}

/** Decodifica entidades SGML/XML comuns (nomeadas e numéricas) num valor de tag. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&"); // por último, para não redecodificar
}

/** Valor de tag SGML sem fechamento: tudo até o próximo "<" ou fim de linha. */
function tagValue(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  const value = m?.[1].trim();
  return value ? decodeEntities(value) : undefined;
}

/** DTPOSTED "YYYYMMDD[hhmmss[fuso]]" → ISODate; pega os 8 primeiros dígitos. */
function parseOfxDate(raw: string | undefined): ISODate | null {
  const m = raw ? /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim()) : null;
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isISODate(iso) ? iso : null;
}

/**
 * Corpo do agregado <LEDGERBAL>. Recortado ANTES de ler os campos porque
 * <AVAILBAL> tem <BALAMT> e <DTASOF> com os mesmos nomes — ler no arquivo
 * inteiro pegaria o saldo disponível no lugar do contábil. Tolera fechamento
 * ausente: corta no </LEDGERBAL> ou no <AVAILBAL>, o que vier primeiro.
 */
function extractLedgerBalBlock(content: string): string | undefined {
  const i = content.search(/<LEDGERBAL>/i);
  if (i < 0) return undefined;
  const rest = content.slice(i + "<LEDGERBAL>".length);
  const fim = rest.search(/<\/LEDGERBAL>|<AVAILBAL>/i);
  return fim < 0 ? rest : rest.slice(0, fim);
}

export function parseOfx(content: string): ParsedStatement {
  const warnings: string[] = [];
  const transactions: StatementTransaction[] = [];

  const accountId = tagValue(content, "ACCTID");

  // Saldo declarado pelo banco. Ausente é o caso normal (CSV/CNAB nem têm, e
  // nem todo OFX traz) — não gera warning. Presente mas ilegível gera, porque
  // aí houve perda de informação.
  let ledgerBalance: ParsedStatement["ledgerBalance"];
  const blocoSaldo = extractLedgerBalBlock(content);
  if (blocoSaldo !== undefined) {
    const bruto = tagValue(blocoSaldo, "BALAMT");
    const amountCents = bruto ? parseDecimalToCents(bruto) : null;
    const date = parseOfxDate(tagValue(blocoSaldo, "DTASOF"));
    if (amountCents !== null && date) {
      ledgerBalance = { amountCents, date };
    } else {
      warnings.push(
        `Saldo do banco ignorado: <LEDGERBAL> com <BALAMT> ("${bruto ?? ""}") ou <DTASOF> inválido.`
      );
    }
  }

  const blocks = extractTransactionBlocks(content);
  if (blocks.length === 0) {
    warnings.push("Nenhum bloco <STMTTRN> encontrado no arquivo OFX.");
  }

  blocks.forEach((block, index) => {
    const position = index + 1;
    const date = parseOfxDate(tagValue(block, "DTPOSTED"));
    if (!date) {
      warnings.push(
        `Transação ${position} ignorada: <DTPOSTED> ausente ou inválido ("${tagValue(block, "DTPOSTED") ?? ""}").`
      );
      return;
    }
    const rawAmount = tagValue(block, "TRNAMT");
    const amountCents = rawAmount ? parseDecimalToCents(rawAmount) : null;
    if (amountCents === null) {
      warnings.push(
        `Transação ${position} ignorada: <TRNAMT> ausente ou inválido ("${rawAmount ?? ""}").`
      );
      return;
    }

    const memo = tagValue(block, "MEMO");
    const name = tagValue(block, "NAME");
    let description: string;
    if (memo && name && memo !== name) description = `${name} - ${memo}`;
    else description = memo ?? name ?? "";
    if (!description) {
      warnings.push(`Transação ${position} sem <MEMO>/<NAME>; descrição vazia mantida.`);
    }

    transactions.push({
      date,
      amountCents,
      description,
      fitid: tagValue(block, "FITID"),
    });
  });

  return { transactions, accountId, warnings, ledgerBalance };
}
