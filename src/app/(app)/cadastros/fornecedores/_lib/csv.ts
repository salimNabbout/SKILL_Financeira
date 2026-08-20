/**
 * Import/export CSV do cadastro de fornecedores. Funções puras (sem Next),
 * testáveis em Node. O CSV usa separador ";" (padrão pt-BR/Excel).
 */

import type { CostClassification, Supplier } from "@/core/entities";
import { toTitleCase, toUpperName } from "@/app/(app)/cadastros/_lib/form-utils";

/** Rótulos de coluna do CSV (também servem de cabeçalho na exportação). */
export const SUPPLIER_CSV_COLUMNS = [
  "Fornecedor",
  "CNPJ/CPF",
  "E-mail",
  "Telefone",
  "Classificação do Custo",
  "Categoria",
  "Situação",
] as const;

function costLabel(c: CostClassification | undefined): string {
  if (c === "fixed") return "Custo Fixo";
  if (c === "variable") return "Custo Variável";
  return "";
}

function costFromLabel(label: string): CostClassification | undefined {
  const v = label.trim().toLowerCase();
  if (v === "custo fixo" || v === "fixo" || v === "fixed") return "fixed";
  if (v === "custo variável" || v === "custo variavel" || v === "variável" || v === "variavel" || v === "variable")
    return "variable";
  return undefined;
}

/** Uma linha (objeto) por fornecedor, pronta para o exportador toCsv. */
export function suppliersToCsvRows(suppliers: Supplier[]): Array<Record<string, string>> {
  return suppliers.map((s) => ({
    Fornecedor: s.name,
    "CNPJ/CPF": s.document ?? "",
    "E-mail": s.email ?? "",
    Telefone: s.phone ?? "",
    "Classificação do Custo": costLabel(s.costClassification),
    Categoria: s.category ?? "",
    Situação: s.active ? "Ativo" : "Inativo",
  }));
}

/** Entrada de fornecedor derivada de uma linha de CSV importado. */
export interface SupplierImportEntry {
  name: string;
  document: string;
  email?: string;
  phone?: string;
  costClassification?: CostClassification;
  category?: string;
}

export interface ParseSuppliersResult {
  entries: SupplierImportEntry[];
  errors: string[];
}

/** Divide uma linha CSV por ";" respeitando aspas simples de célula. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ";" && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Lê o CSV (com cabeçalho) para entradas de fornecedor. Normaliza nome
 * (MAIÚSCULAS) e categoria (Title Case). CNPJ/CPF é obrigatório — linha sem ele
 * vira erro (não entra). Colunas extras são ignoradas; ordem segue o cabeçalho.
 */
export function parseSuppliersCsv(text: string): ParseSuppliersResult {
  const clean = text.replace(/^﻿/, ""); // remove BOM
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const entries: SupplierImportEntry[] = [];
  const errors: string[] = [];
  if (lines.length === 0) return { entries, errors };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const iName = idx("Fornecedor");
  const iDoc = idx("CNPJ/CPF");
  const iEmail = idx("E-mail");
  const iPhone = idx("Telefone");
  const iCost = idx("Classificação do Custo");
  const iCat = idx("Categoria");
  if (iName < 0 || iDoc < 0) {
    errors.push("Cabeçalho inválido: são obrigatórias as colunas 'Fornecedor' e 'CNPJ/CPF'.");
    return { entries, errors };
  }

  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const rawName = (cells[iName] ?? "").trim();
    const document = (cells[iDoc] ?? "").trim();
    if (!rawName) {
      errors.push(`Linha ${r + 1}: nome do fornecedor vazio.`);
      continue;
    }
    if (!document) {
      errors.push(`Linha ${r + 1}: CNPJ/CPF (documento) é obrigatório.`);
      continue;
    }
    const email = iEmail >= 0 ? (cells[iEmail] ?? "").trim() : "";
    const phone = iPhone >= 0 ? (cells[iPhone] ?? "").trim() : "";
    const category = iCat >= 0 ? (cells[iCat] ?? "").trim() : "";
    entries.push({
      name: toUpperName(rawName),
      document,
      email: email || undefined,
      phone: phone || undefined,
      costClassification: iCost >= 0 ? costFromLabel(cells[iCost] ?? "") : undefined,
      category: category ? toTitleCase(category) : undefined,
    });
  }
  return { entries, errors };
}
