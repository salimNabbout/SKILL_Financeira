/**
 * Carrega TODOS os títulos a receber que atendem aos filtros — sem paginação —
 * junto dos dados auxiliares para exportar e imprimir.
 *
 * A listagem da tela usa `listPage` por volumetria; exportação e impressão
 * precisam do conjunto inteiro, senão o arquivo sairia com uma página só e
 * ninguém notaria até somar os totais.
 */

import type { Receivable } from "@/core/entities";
import type { Repositories } from "@/core/repositories";
import { receiptIsActive } from "@/core/money";
import type { ReceivableFilters } from "./filters";
import type { ExportLookups } from "./export-rows";

/** Teto de segurança: evita que um filtro amplo derrube a geração do PDF. */
export const EXPORT_LIMIT = 5000;

export interface FilteredReceivables {
  receivables: Receivable[];
  lookups: ExportLookups;
  /** Nome do cliente quando há filtro por cliente (para o cabeçalho). */
  customerNameFiltrado?: string;
  /** true quando o teto foi atingido e a lista está truncada. */
  truncado: boolean;
}

export async function loadFilteredReceivables(
  repos: Repositories,
  companyId: string,
  filtros: ReceivableFilters
): Promise<FilteredReceivables> {
  const [page, customers, costCenters, bankAccounts, categories] = await Promise.all([
    repos.receivables.listPage(companyId, {
      offset: 0,
      limit: EXPORT_LIMIT,
      statuses: filtros.statuses,
      customerId: filtros.customerId,
      dueFrom: filtros.dueFrom,
      dueTo: filtros.dueTo,
    }),
    repos.customers.listAll(companyId),
    repos.costCenters.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
    repos.categories.listAll(companyId),
  ]);

  const receivables = page.items;

  // Conta de recebimento e nº do documento: um lote por título, em vez de
  // getById dentro do laço.
  const bankAccountIdByReceivable = new Map<string, string>();
  const documentNumberByReceivable = new Map<string, string>();

  await Promise.all(
    receivables.map(async (r) => {
      const recibos = (
        await repos.receipts.listByReceivable(companyId, r.id)
      ).filter(receiptIsActive);
      const comConta = recibos.find((x) => x.bankAccountId);
      if (comConta?.bankAccountId) bankAccountIdByReceivable.set(r.id, comConta.bankAccountId);

      if (r.documentId) {
        const doc = await repos.documents.getById(companyId, r.documentId);
        if (doc) {
          documentNumberByReceivable.set(r.id, doc.series ? `${doc.number}/${doc.series}` : doc.number);
        }
      }
    })
  );

  return {
    receivables,
    lookups: {
      customers,
      costCenters,
      bankAccounts,
      categoryNameById: new Map(categories.map((c) => [c.id, c.name])),
      bankAccountIdByReceivable,
      documentNumberByReceivable,
    },
    customerNameFiltrado: filtros.customerId
      ? customers.find((c) => c.id === filtros.customerId)?.name
      : undefined,
    truncado: page.total > receivables.length,
  };
}
