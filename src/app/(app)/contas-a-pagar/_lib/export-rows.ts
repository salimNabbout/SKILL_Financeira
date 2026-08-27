/**
 * Linhas de exportação de Contas a Pagar — as mesmas colunas em CSV, PDF e na
 * visão de impressão, para os três nunca divergirem.
 *
 * Função pura, sem dependência de Next/server.
 */

import type { BankAccount, CostCenter, Payable, Supplier } from "@/core/entities";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";

export const PAYABLE_EXPORT_COLUMNS = [
  "Fornecedor",
  "Descrição",
  "Nº do Documento",
  "Categoria",
  "Classificação",
  "Centro de Custo",
  "Parcela",
  "Emissão",
  "Vencimento",
  "Valor (R$)",
  "Valor Pago (R$)",
  "Status",
  "Conta de Pagamento",
] as const;

export type PayableExportColumn = (typeof PAYABLE_EXPORT_COLUMNS)[number];
export type PayableExportRow = Record<PayableExportColumn, string>;

const CLASSIFICACAO: Record<string, string> = {
  fixed: "Custo Fixo",
  variable: "Custo Variável",
};

/** Dados auxiliares para resolver os nomes exibidos. */
export interface ExportLookups {
  suppliers: Supplier[];
  costCenters: CostCenter[];
  bankAccounts: BankAccount[];
  /** Conta de pagamento por título, quando há pagamento vinculado. */
  bankAccountIdByPayable?: Map<string, string>;
  /** Nº do documento por título, quando há documento vinculado. */
  documentNumberByPayable?: Map<string, string>;
}

/**
 * Converte títulos em linhas de exportação.
 *
 * Valores saem formatados em pt-BR (1.234,56) a partir dos centavos, e datas em
 * DD/MM/AAAA — o arquivo é lido por pessoas e aberto no Excel brasileiro, não
 * consumido por outro sistema.
 */
export function payablesToExportRows(
  payables: Payable[],
  lookups: ExportLookups
): PayableExportRow[] {
  const supplierName = new Map(lookups.suppliers.map((s) => [s.id, s.name]));
  const costCenterLabel = new Map(
    lookups.costCenters.map((c) => [c.id, `${c.code} — ${c.name}`])
  );
  const bankAccountName = new Map(lookups.bankAccounts.map((b) => [b.id, b.name]));

  return payables.map((p) => {
    const contaId = lookups.bankAccountIdByPayable?.get(p.id);
    return {
      Fornecedor: supplierName.get(p.supplierId) ?? p.supplierId,
      Descrição: p.description,
      "Nº do Documento": lookups.documentNumberByPayable?.get(p.id) ?? "",
      Categoria: p.supplierCategory ?? "",
      Classificação: p.costClassification ? (CLASSIFICACAO[p.costClassification] ?? "") : "",
      "Centro de Custo": p.costCenterId ? (costCenterLabel.get(p.costCenterId) ?? "") : "",
      Parcela: `${p.installmentNumber}/${p.installmentCount}`,
      Emissão: formatBR(p.issueDate),
      Vencimento: formatBR(p.dueDate),
      // Sem o "R$" na célula: o rótulo da coluna já diz, e assim o Excel
      // reconhece o número em vez de tratar tudo como texto.
      "Valor (R$)": formatBRL(p.amountCents).replace("R$", "").trim(),
      "Valor Pago (R$)": formatBRL(p.paidCents).replace("R$", "").trim(),
      Status: statusLabel(p.status),
      "Conta de Pagamento": contaId ? (bankAccountName.get(contaId) ?? "") : "",
    };
  });
}

export interface ExportTotals {
  quantidade: number;
  valorCents: number;
  pagoCents: number;
}

export function totalsOf(payables: Payable[]): ExportTotals {
  return {
    quantidade: payables.length,
    valorCents: payables.reduce((acc, p) => acc + p.amountCents, 0),
    pagoCents: payables.reduce((acc, p) => acc + p.paidCents, 0),
  };
}
