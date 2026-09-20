/**
 * Importação da aba "Lançamentos" da planilha exportada pelo app — regras de
 * domínio puras (sem ZIP, sem banco): validação linha a linha, tudo-ou-nada,
 * e a deduplicação que impede a reimportação de contar duas vezes.
 *
 * O que vira ajuste manual (`fc_ajuste_manual`): só linhas NOVAS, isto é, com
 * a coluna Origem em branco (ou "Ajuste manual" sem referência conhecida).
 *  - Origem do app (Contas a pagar / Contas a receber / Conciliação bancária)
 *    → ignorada: o lançamento já existe no app e reimportá-lo duplicaria o
 *    caixa. Correções de categoria são feitas no app (de-para).
 *  - Ajuste manual com Referência de um ajuste existente → ignorada (já
 *    existe); se o conteúdo divergir, vira aviso (edite no app).
 *  - Linha idêntica a um ajuste manual já gravado (mesma data, tipo,
 *    categoria, descrição, centro, status e valor) → ignorada como duplicada:
 *    importar o mesmo arquivo duas vezes não cria nada na segunda.
 * Qualquer linha com erro rejeita o arquivo inteiro (nada é gravado).
 */

import type { CashflowCategory, CashflowManualEntry, CostCenter } from "@/core/entities";
import { normalizeKey } from "./unify";

type ISODate = string;

export interface CashflowImportRawRow {
  /** Número da linha na planilha (1 = cabeçalho). */
  linha: number;
  data?: unknown;
  tipo?: unknown;
  categoria?: unknown;
  descricao?: unknown;
  centro?: unknown;
  status?: unknown;
  valor?: unknown;
  origem?: unknown;
  referencia?: unknown;
}

export interface CashflowImportRow {
  linha: number;
  competenceDate: ISODate;
  kind: "entrada" | "saida";
  categoryId: string;
  categoryName: string;
  description: string;
  costCenterId?: string;
  costCenterName?: string;
  status: "previsto" | "realizado";
  amountCents: number;
}

export interface CashflowImportError {
  linha: number;
  motivo: string;
  conteudo: string[];
}

export type CashflowImportSkipReason = "origem_app" | "ja_existente" | "duplicado";

export interface CashflowImportSkipped {
  linha: number;
  motivo: CashflowImportSkipReason;
  detalhe: string;
}

export interface CashflowImportValidation {
  linhasLidas: number;
  validas: CashflowImportRow[];
  erros: CashflowImportError[];
  ignoradas: CashflowImportSkipped[];
  avisos: string[];
  totais: { entradasCents: number; saidasCents: number };
}

export interface CashflowImportContext {
  categories: CashflowCategory[];
  costCenters: Array<Pick<CostCenter, "id" | "code" | "name" | "active">>;
  manualEntries: CashflowManualEntry[];
}

export const SKIP_REASON_LABEL: Record<CashflowImportSkipReason, string> = {
  origem_app: "Origem do app (já existe no Financeira PME)",
  ja_existente: "Ajuste manual já gravado (referência conhecida)",
  duplicado: "Idêntica a um ajuste manual já gravado",
};

// ---------------------------------------------------------------------------
// Parsers de célula
// ---------------------------------------------------------------------------

const ORIGENS_APP = new Set(["contas a pagar", "a pagar", "contas a receber", "a receber", "conciliacao", "conciliacao bancaria"]);
const ORIGENS_MANUAIS = new Set(["", "ajuste manual", "manual", "importacao", "importacao planilha", "importacao de planilha"]);

function isValidIso(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1990 && y <= 2100;
}

/** Número de série do Excel (dias desde 1899-12-30) → ISO. */
function serialToIso(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Data em número de série, "YYYY-MM-DD" (com ou sem hora) ou "DD/MM/YYYY". */
export function parseImportDate(raw: unknown): ISODate | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 30_000 || raw > 80_000) return null; // ~1982..2119
    const iso = serialToIso(raw);
    return isValidIso(iso) ? iso : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return isValidIso(iso) ? iso : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return isValidIso(iso) ? iso : null;
  }
  return null;
}

/** Valor → centavos inteiros. Número da planilha ou texto "1.234,56" / "1234.56" / "R$ 1.234,56". */
export function parseImportAmount(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    // Duas casas exatas via string: evita 0.1 + 0.2 do float.
    return Number(raw.toFixed(2).replace(".", ""));
  }
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/R\$\s*/gi, "").replace(/\s+/g, "");
  if (!s) return null;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  let decimal: string;
  if (s.includes(",")) {
    decimal = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    decimal = s;
  } else {
    decimal = s.replace(/\./g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(decimal)) return null;
  const [int, frac = ""] = decimal.split(".");
  const cents = Number(int) * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -cents : cents;
}

function asText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") return Number.isInteger(raw) ? String(raw) : String(raw);
  return String(raw).trim();
}

/** Assinatura de conteúdo: mesma data, tipo, categoria, descrição, centro, status e valor. */
export function manualEntrySignature(e: {
  competenceDate: string;
  kind: string;
  categoryId: string;
  description: string;
  costCenterId?: string;
  status: string;
  amountCents: number;
}): string {
  return [e.competenceDate, e.kind, e.categoryId, normalizeKey(e.description), e.costCenterId ?? "", e.status, e.amountCents].join("|");
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

export function validateCashflowImport(rows: CashflowImportRawRow[], ctx: CashflowImportContext): CashflowImportValidation {
  const byName = new Map<string, CashflowCategory>();
  const byId = new Map<string, CashflowCategory>();
  for (const c of ctx.categories) {
    if (c.kind === "neutro") continue;
    byName.set(normalizeKey(c.name), c);
    byId.set(c.id, c);
  }
  const ccByKey = new Map<string, CashflowImportContext["costCenters"][number]>();
  for (const cc of ctx.costCenters) {
    ccByKey.set(normalizeKey(cc.name), cc);
    ccByKey.set(normalizeKey(cc.code), cc);
    ccByKey.set(normalizeKey(`${cc.code} - ${cc.name}`), cc);
    ccByKey.set(cc.id, cc);
  }
  const existingById = new Map(ctx.manualEntries.map((e) => [e.id, e]));
  const existingSignatures = new Map(ctx.manualEntries.map((e) => [manualEntrySignature(e), e]));

  const validas: CashflowImportRow[] = [];
  const erros: CashflowImportError[] = [];
  const ignoradas: CashflowImportSkipped[] = [];
  const avisos: string[] = [];
  const seen = new Map<string, number>();
  let linhasLidas = 0;
  let entradasCents = 0;
  let saidasCents = 0;

  for (const raw of rows) {
    const conteudo = [raw.data, raw.tipo, raw.categoria, raw.descricao, raw.centro, raw.status, raw.valor, raw.origem, raw.referencia].map(asText);
    const vazia = [raw.data, raw.tipo, raw.categoria, raw.descricao, raw.valor].every((v) => asText(v) === "");
    if (vazia) continue;
    linhasLidas += 1;
    const fail = (motivo: string) => erros.push({ linha: raw.linha, motivo, conteudo });

    // Origem decide se a linha é nova (importável) ou já vive no app.
    const origem = normalizeKey(asText(raw.origem));
    if (ORIGENS_APP.has(origem)) {
      ignoradas.push({ linha: raw.linha, motivo: "origem_app", detalhe: `origem "${asText(raw.origem)}"${asText(raw.referencia) ? ` (${asText(raw.referencia)})` : ""}` });
      continue;
    }
    if (!ORIGENS_MANUAIS.has(origem)) {
      fail(`Origem "${asText(raw.origem)}" desconhecida. Deixe em branco para importar a linha como ajuste manual.`);
      continue;
    }

    const problemas: string[] = [];
    const competenceDate = parseImportDate(raw.data);
    if (!competenceDate) problemas.push("Data inválida (use DD/MM/AAAA ou uma data do Excel)");

    const tipoKey = normalizeKey(asText(raw.tipo));
    const kind: CashflowImportRow["kind"] | null = tipoKey === "entrada" ? "entrada" : tipoKey === "saida" ? "saida" : null;
    if (!kind) problemas.push(`Tipo "${asText(raw.tipo)}" inválido (Entrada ou Saída)`);

    const catText = asText(raw.categoria);
    const category = byName.get(normalizeKey(catText)) ?? byId.get(catText);
    if (!category) problemas.push(`Categoria "${catText}" não existe no plano`);
    else if (kind && category.kind !== kind) {
      problemas.push(`Categoria "${category.name}" é de ${category.kind === "entrada" ? "entrada" : "saída"}; a linha é de ${kind === "entrada" ? "entrada" : "saída"}`);
    }

    const description = asText(raw.descricao);
    if (!description) problemas.push("Descrição obrigatória");
    else if (description.length > 300) problemas.push("Descrição acima de 300 caracteres");

    const centroText = asText(raw.centro);
    const costCenter = centroText ? ccByKey.get(normalizeKey(centroText)) ?? ccByKey.get(centroText) : undefined;
    if (centroText && !costCenter) problemas.push(`Centro de custo "${centroText}" não cadastrado`);

    const statusKey = normalizeKey(asText(raw.status));
    const status: CashflowImportRow["status"] | null = statusKey === "realizado" ? "realizado" : statusKey === "previsto" ? "previsto" : null;
    if (!status) problemas.push(`Status "${asText(raw.status)}" inválido (Realizado ou Previsto)`);

    const amountCents = parseImportAmount(raw.valor);
    if (amountCents === null) problemas.push(`Valor "${asText(raw.valor)}" inválido`);
    else if (amountCents <= 0) problemas.push("Valor deve ser positivo; o sinal vem do Tipo");

    if (problemas.length > 0 || !competenceDate || !kind || !category || !status || amountCents === null) {
      fail(problemas.join("; "));
      continue;
    }

    const row: CashflowImportRow = {
      linha: raw.linha,
      competenceDate,
      kind,
      categoryId: category.id,
      categoryName: category.name,
      description,
      costCenterId: costCenter?.id,
      costCenterName: costCenter?.name,
      status,
      amountCents,
    };

    // Ajuste manual já existente (referência) ou idêntico (assinatura).
    const referencia = asText(raw.referencia);
    if (referencia) {
      const existing = existingById.get(referencia);
      if (existing) {
        const same = manualEntrySignature(existing) === manualEntrySignature(row);
        ignoradas.push({ linha: raw.linha, motivo: "ja_existente", detalhe: `ajuste manual ${referencia}${same ? "" : " (conteúdo diverge do app — edite na tela Lançamentos)"}` });
        if (!same) avisos.push(`Linha ${raw.linha}: o ajuste manual ${referencia} foi alterado na planilha; a importação não altera ajustes existentes.`);
        continue;
      }
      avisos.push(`Linha ${raw.linha}: referência "${referencia}" não encontrada; importada como ajuste manual novo.`);
    }
    const signature = manualEntrySignature(row);
    const dup = existingSignatures.get(signature);
    if (dup) {
      ignoradas.push({ linha: raw.linha, motivo: "duplicado", detalhe: `igual ao ajuste manual ${dup.id} (${dup.sourceNote ?? "criado no app"})` });
      continue;
    }
    const seenAt = seen.get(signature);
    if (seenAt) avisos.push(`Linha ${raw.linha}: idêntica à linha ${seenAt} do mesmo arquivo; as duas serão importadas.`);
    else seen.set(signature, raw.linha);

    validas.push(row);
    if (kind === "entrada") entradasCents += amountCents;
    else saidasCents += amountCents;
  }

  return { linhasLidas, validas, erros, ignoradas, avisos, totais: { entradasCents, saidasCents } };
}
