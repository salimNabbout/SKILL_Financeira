/**
 * Linhas de exportação de Contas a Receber — as mesmas colunas em CSV, PDF e na
 * visão de impressão, para os três nunca divergirem.
 *
 * Função pura, sem dependência de Next/server.
 */

import type { BankAccount, CostCenter, Customer, Receivable } from "@/core/entities";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";

export const RECEIVABLE_EXPORT_COLUMNS = [
  "Cliente",
  "Descrição",
  "Nº do Documento",
  "Categoria",
  "Centro de Custo",
  "Parcela",
  "Emissão",
  "Vencimento",
  "Valor (R$)",
  "Valor Recebido (R$)",
  "Status",
  "Conta de Recebimento",
] as const;

export type ReceivableExportColumn = (typeof RECEIVABLE_EXPORT_COLUMNS)[number];
export type ReceivableExportRow = Record<ReceivableExportColumn, string>;

/** Dados auxiliares para resolver os nomes exibidos. */
export interface ExportLookups {
  customers: Customer[];
  costCenters: CostCenter[];
  bankAccounts: BankAccount[];
  categoryNameById?: Map<string, string>;
  /** Conta de recebimento por título, quando há recebimento vinculado. */
  bankAccountIdByReceivable?: Map<string, string>;
  /** Nº do documento por título, quando há documento vinculado. */
  documentNumberByReceivable?: Map<string, string>;
}

/**
 * Converte títulos em linhas de exportação.
 *
 * Valores saem formatados em pt-BR (1.234,56) a partir dos centavos, e datas em
 * DD/MM/AAAA — o arquivo é lido por pessoas e aberto no Excel brasileiro.
 */
export function receivablesToExportRows(
  receivables: Receivable[],
  lookups: ExportLookups
): ReceivableExportRow[] {
  const customerName = new Map(lookups.customers.map((c) => [c.id, c.name]));
  const costCenterLabel = new Map(
    lookups.costCenters.map((c) => [c.id, `${c.code} — ${c.name}`])
  );
  const bankAccountName = new Map(lookups.bankAccounts.map((b) => [b.id, b.name]));

  return receivables.map((r) => {
    const contaId = lookups.bankAccountIdByReceivable?.get(r.id);
    return {
      Cliente: customerName.get(r.customerId) ?? r.customerId,
      Descrição: r.description,
      "Nº do Documento": lookups.documentNumberByReceivable?.get(r.id) ?? "",
      Categoria: r.categoryId ? (lookups.categoryNameById?.get(r.categoryId) ?? "") : "",
      "Centro de Custo": r.costCenterId ? (costCenterLabel.get(r.costCenterId) ?? "") : "",
      Parcela: `${r.installmentNumber}/${r.installmentCount}`,
      Emissão: formatBR(r.issueDate),
      Vencimento: formatBR(r.dueDate),
      // Sem o "R$" na célula: o rótulo da coluna já diz, e assim o Excel
      // reconhece o número em vez de tratar tudo como texto.
      "Valor (R$)": formatBRL(r.amountCents).replace("R$", "").trim(),
      "Valor Recebido (R$)": formatBRL(r.receivedCents).replace("R$", "").trim(),
      Status: statusLabel(r.status),
      "Conta de Recebimento": contaId ? (bankAccountName.get(contaId) ?? "") : "",
    };
  });
}

export interface ExportTotals {
  /** Títulos somados (sem os cancelados). */
  quantidade: number;
  valorCents: number;
  recebidoCents: number;
  /** Cancelados presentes na listagem e deixados fora da soma. */
  cancelados: number;
}

/**
 * Totais do conjunto exportado/impresso. Título cancelado aparece na lista
 * (com status "Cancelado"), mas não é direito a receber: fica fora de Σ Valor
 * e Σ Recebido e é contado à parte, para o rodapé dizer quantos ficaram de fora.
 */
export function totalsOf(receivables: Receivable[]): ExportTotals {
  const somados = receivables.filter((r) => r.status !== "canceled");
  return {
    quantidade: somados.length,
    valorCents: somados.reduce((acc, r) => acc + r.amountCents, 0),
    recebidoCents: somados.reduce((acc, r) => acc + r.receivedCents, 0),
    cancelados: receivables.length - somados.length,
  };
}

/** Rótulo do rodapé: "TOTAL — 8 título(s) (2 cancelado(s) fora da soma)". */
export function totalsLabel(totais: ExportTotals): string {
  const base = `TOTAL — ${totais.quantidade} título(s)`;
  return totais.cancelados > 0
    ? `${base} (${totais.cancelados} cancelado(s) fora da soma)`
    : base;
}
