/**
 * Linhas de exportação de Contas a Pagar — as mesmas colunas em CSV, PDF e na
 * visão de impressão, para os três nunca divergirem. Única exceção, pedida
 * para a planilha: o CSV leva também "Data de Pagamento" (PAYABLE_CSV_COLUMNS).
 *
 * Função pura, sem dependência de Next/server.
 */

import type { ISODate } from "@/core/dates";
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

/**
 * Colunas do CSV: as do PDF/impressão mais "Data de Pagamento" (a data em que
 * o pagamento foi conciliado — a mesma que define Pago / Pago no Vencimento /
 * Pago Atrasado na tela), logo após o valor pago.
 */
export const PAYABLE_CSV_COLUMNS = [
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
  "Data de Pagamento",
  "Status",
  "Conta de Pagamento",
] as const;

export type PayableCsvColumn = (typeof PAYABLE_CSV_COLUMNS)[number];
export type PayableExportRow = Record<PayableCsvColumn, string>;

/**
 * Colunas que o CSV precisa forçar como TEXTO: "1/17" (parcela) viraria a data
 * jan/17 no Excel. A tela mostra "1/17"; o arquivo tem de mostrar o mesmo.
 */
export const PAYABLE_CSV_TEXT_COLUMNS: ReadonlySet<PayableCsvColumn> = new Set<PayableCsvColumn>([
  "Parcela",
]);

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
  /** Data (no fuso da empresa) da conciliação do pagamento que quitou o título. */
  paymentDateByPayable?: Map<string, ISODate>;
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
    const pagoEm = lookups.paymentDateByPayable?.get(p.id);
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
      // Vazia sem pagamento conciliado (título em aberto ou baixado pela
      // conciliação bancária, que não cria pagamento).
      "Data de Pagamento": pagoEm ? formatBR(pagoEm) : "",
      Status: statusLabel(p.status),
      "Conta de Pagamento": contaId ? (bankAccountName.get(contaId) ?? "") : "",
    };
  });
}

export interface ExportTotals {
  /** Títulos somados (sem os cancelados). */
  quantidade: number;
  valorCents: number;
  pagoCents: number;
  /** Cancelados presentes na listagem e deixados fora da soma. */
  cancelados: number;
}

/**
 * Totais do conjunto exportado/impresso. Título cancelado aparece na lista
 * (com status "Cancelado"), mas não é obrigação: fica fora de Σ Valor e
 * Σ Pago e é contado à parte, para o rodapé dizer quantos ficaram de fora.
 */
export function totalsOf(payables: Payable[]): ExportTotals {
  const somados = payables.filter((p) => p.status !== "canceled");
  return {
    quantidade: somados.length,
    valorCents: somados.reduce((acc, p) => acc + p.amountCents, 0),
    pagoCents: somados.reduce((acc, p) => acc + p.paidCents, 0),
    cancelados: payables.length - somados.length,
  };
}

/** Rótulo do rodapé: "TOTAL — 8 título(s) (2 cancelado(s) fora da soma)". */
export function totalsLabel(totais: ExportTotals): string {
  const base = `TOTAL — ${totais.quantidade} título(s)`;
  return totais.cancelados > 0
    ? `${base} (${totais.cancelados} cancelado(s) fora da soma)`
    : base;
}
