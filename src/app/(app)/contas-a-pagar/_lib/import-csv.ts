/**
 * Importação de títulos a pagar por CSV: modelo, parsing e validação.
 *
 * Funções puras (sem Next/server), testáveis em Node. NADA aqui grava —
 * a validação roda inteira antes de qualquer escrita, para o usuário ver o que
 * vai acontecer e poder desistir.
 */

import type { CostCenter, Payable, Supplier, SupplierCategory } from "@/core/entities";
import { isISODate } from "@/core/dates";
import { parseCsv } from "@/lib/importers/csv";
import { normalizeText } from "@/lib/importers/common";
import { parseBRLToCents } from "@/app/(app)/cadastros/_lib/form-utils";

export const IMPORT_CSV_COLUMNS = [
  "Fornecedor",
  "Descrição",
  "Valor",
  "Nº do Documento",
  "Emissão",
  "Vencimento",
  "Categoria",
  "Classificação do Custo",
  "Centro de Custo",
  "Tipo de Lançamento",
  "Número de Parcelas",
] as const;

/** Máximo de linhas por arquivo — a pré-visualização trafega no formulário. */
export const IMPORT_MAX_ROWS = 500;

/** Modelo CSV com uma linha de exemplo, para o usuário não adivinhar o formato. */
export function buildImportTemplate(): string {
  const exemplo = [
    "FORNECEDORA ALFA LTDA",
    "NF 1234 - insumos",
    "1.234,56",
    "1234",
    "10/06/2026",
    "10/07/2026",
    "Insumos Gerais",
    "Custo Fixo",
    "CC-01",
    "Único",
    "1",
  ];
  return (
    "﻿" +
    IMPORT_CSV_COLUMNS.join(";") +
    "\r\n" +
    exemplo.join(";") +
    "\r\n"
  );
}

export interface ImportRowInput {
  fornecedor: string;
  descricao: string;
  valor: string;
  documento: string;
  emissao: string;
  vencimento: string;
  categoria: string;
  classificacao: string;
  centroDeCusto: string;
  tipoLancamento: string;
  parcelas: string;
}

/** Linha já validada e pronta para virar payload do fluxo de entrada. */
export interface ImportRowValid {
  linha: number;
  supplierId: string;
  supplierName: string;
  description: string;
  amountCents: number;
  documentNumber?: string;
  issueDate: string;
  dueDate: string;
  supplierCategory: string;
  costClassification: "fixed" | "variable";
  costCenterId?: string;
  installmentCount: number;
  /** true quando já existe título do mesmo fornecedor com o mesmo documento. */
  duplicado: boolean;
}

export interface ImportRowError {
  linha: number;
  motivo: string;
  bruto: string[];
}

export interface ImportPreview {
  validas: ImportRowValid[];
  erros: ImportRowError[];
  /** true quando o arquivo passou do teto e foi cortado. */
  truncado: boolean;
}

/** Aceita DD/MM/AAAA (o modelo) e AAAA-MM-DD (quem exporta de outro sistema). */
export function parseDataBR(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (isISODate(v)) return v;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return isISODate(iso) ? iso : null;
}

function classificacaoDe(raw: string): "fixed" | "variable" | null {
  const v = normalizeText(raw).toLowerCase();
  if (v.includes("fix")) return "fixed";
  if (v.includes("varia")) return "variable";
  return null;
}

/** Comparação de nomes tolerante a acento e caixa. */
function chave(valor: string): string {
  return normalizeText(valor).toLowerCase().trim();
}

export interface ImportContext {
  suppliers: Supplier[];
  categories: SupplierCategory[];
  costCenters: CostCenter[];
  /** Títulos já existentes, para marcar duplicidade por fornecedor+documento. */
  payables: Payable[];
  /** Nº do documento de cada título existente. */
  documentNumberByPayable: Map<string, string>;
}

/**
 * Valida o CSV inteiro linha a linha.
 *
 * Uma linha inválida não impede as demais: o usuário vê o que passa e o que
 * falha, com o motivo, e decide. A duplicidade NÃO é erro — é aviso, com a
 * mesma chave usada no fluxo de entrada de nota (fornecedor + documento).
 */
export function validateImportCsv(content: string, ctx: ImportContext): ImportPreview {
  const linhas = parseCsv(content, ";");
  if (linhas.length === 0) {
    return { validas: [], erros: [], truncado: false };
  }

  // Primeira linha é cabeçalho quando bate com o modelo.
  const primeira = linhas[0].map((c) => chave(c));
  const temCabecalho = primeira.includes(chave("Fornecedor")) && primeira.includes(chave("Valor"));
  const corpo = temCabecalho ? linhas.slice(1) : linhas;
  const truncado = corpo.length > IMPORT_MAX_ROWS;
  const alvo = truncado ? corpo.slice(0, IMPORT_MAX_ROWS) : corpo;

  const porNomeFornecedor = new Map(ctx.suppliers.filter((s) => s.active).map((s) => [chave(s.name), s]));
  const porNomeCategoria = new Map(ctx.categories.filter((c) => c.active).map((c) => [chave(c.name), c]));
  const porCodigoCentro = new Map(
    ctx.costCenters.filter((c) => c.active).map((c) => [chave(c.code), c])
  );
  const porNomeCentro = new Map(
    ctx.costCenters.filter((c) => c.active).map((c) => [chave(c.name), c])
  );

  // Chave de duplicidade: fornecedor + nº do documento, como no intake.
  const jaExiste = new Set<string>();
  for (const p of ctx.payables) {
    const doc = ctx.documentNumberByPayable.get(p.id);
    if (doc) jaExiste.add(`${p.supplierId}|${chave(doc)}`);
  }

  const validas: ImportRowValid[] = [];
  const erros: ImportRowError[] = [];

  alvo.forEach((celulas, i) => {
    // +1 pelo índice-base-1 e +1 quando há cabeçalho: o número precisa bater
    // com o que o usuário vê ao abrir o arquivo.
    const linha = i + 1 + (temCabecalho ? 1 : 0);
    const vazia = celulas.every((c) => !c.trim());
    if (vazia) return;

    const [
      fornecedor = "",
      descricao = "",
      valor = "",
      documento = "",
      emissao = "",
      vencimento = "",
      categoria = "",
      classificacao = "",
      centroDeCusto = "",
      ,
      parcelas = "",
    ] = celulas;

    const falhar = (motivo: string) => erros.push({ linha, motivo, bruto: celulas });

    const supplier = porNomeFornecedor.get(chave(fornecedor));
    if (!fornecedor.trim()) return falhar("Fornecedor não informado.");
    if (!supplier) return falhar(`Fornecedor "${fornecedor}" não está cadastrado (ou está inativo).`);

    if (!descricao.trim()) return falhar("Descrição não informada.");

    let amountCents: number;
    try {
      amountCents = parseBRLToCents(valor);
    } catch {
      return falhar(`Valor inválido: "${valor}". Use o formato 1.234,56.`);
    }
    if (amountCents <= 0) return falhar("O valor deve ser maior que zero.");

    const issueDate = parseDataBR(emissao);
    if (!issueDate) return falhar(`Emissão inválida: "${emissao}". Use DD/MM/AAAA.`);
    const dueDate = parseDataBR(vencimento);
    if (!dueDate) return falhar(`Vencimento inválido: "${vencimento}". Use DD/MM/AAAA.`);
    if (dueDate < issueDate) return falhar("Verificar a Data da Emissão");

    const cat = porNomeCategoria.get(chave(categoria));
    if (!categoria.trim()) return falhar("Categoria não informada.");
    if (!cat) return falhar(`Categoria "${categoria}" não existe em Categoria de Fornecedores.`);

    const cost = classificacaoDe(classificacao);
    if (!cost) return falhar(`Classificação do custo inválida: "${classificacao}". Use Fixo ou Variável.`);

    let costCenterId: string | undefined;
    if (centroDeCusto.trim()) {
      const cc = porCodigoCentro.get(chave(centroDeCusto)) ?? porNomeCentro.get(chave(centroDeCusto));
      if (!cc) return falhar(`Centro de custo "${centroDeCusto}" não está cadastrado.`);
      costCenterId = cc.id;
    }

    const nParcelas = parcelas.trim() ? Number(parcelas.trim()) : 1;
    if (!Number.isInteger(nParcelas) || nParcelas < 1 || nParcelas > 120) {
      return falhar(`Número de parcelas inválido: "${parcelas}" (1 a 120).`);
    }

    const doc = documento.trim();
    validas.push({
      linha,
      supplierId: supplier.id,
      supplierName: supplier.name,
      description: descricao.trim(),
      amountCents,
      documentNumber: doc || undefined,
      issueDate,
      dueDate,
      supplierCategory: cat.name,
      costClassification: cost,
      costCenterId,
      installmentCount: nParcelas,
      duplicado: doc ? jaExiste.has(`${supplier.id}|${chave(doc)}`) : false,
    });
  });

  return { validas, erros, truncado };
}

/** CSV com o log de erros, para o usuário corrigir a planilha de origem. */
export function buildErrorLogCsv(erros: ImportRowError[]): string {
  const linhas = [["Linha", "Motivo", ...IMPORT_CSV_COLUMNS].join(";")];
  for (const e of erros) {
    const celulas = [String(e.linha), e.motivo, ...e.bruto].map((c) =>
      c.includes(";") || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c
    );
    linhas.push(celulas.join(";"));
  }
  return "﻿" + linhas.join("\r\n") + "\r\n";
}
