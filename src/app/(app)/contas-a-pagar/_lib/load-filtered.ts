/**
 * Carrega TODOS os títulos que atendem aos filtros — sem paginação — junto dos
 * dados auxiliares para exportar e imprimir.
 *
 * A listagem da tela usa `listPage` por volumetria; exportação e impressão
 * precisam do conjunto inteiro, senão o arquivo sairia com uma página só e
 * ninguém notaria até somar os totais.
 */

import type { Payable } from "@/core/entities";
import type { Repositories } from "@/core/repositories";
import type { PayableFilters } from "./filters";
import type { ExportLookups } from "./export-rows";

/** Teto de segurança: evita que um filtro amplo derrube a geração do PDF. */
export const EXPORT_LIMIT = 5000;

export interface FilteredPayables {
  payables: Payable[];
  lookups: ExportLookups;
  /** Nome do fornecedor quando há filtro por fornecedor (para o cabeçalho). */
  supplierNameFiltrado?: string;
  /** true quando o teto foi atingido e a lista está truncada. */
  truncado: boolean;
}

export async function loadFilteredPayables(
  repos: Repositories,
  companyId: string,
  filtros: PayableFilters
): Promise<FilteredPayables> {
  const [page, suppliers, costCenters, bankAccounts] = await Promise.all([
    repos.payables.listPage(companyId, {
      offset: 0,
      limit: EXPORT_LIMIT,
      statuses: filtros.statuses,
      supplierId: filtros.supplierId,
      dueFrom: filtros.dueFrom,
      dueTo: filtros.dueTo,
    }),
    repos.suppliers.listAll(companyId),
    repos.costCenters.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
  ]);

  const payables = page.items;

  // Conta de pagamento e nº do documento: um lote por título em vez de
  // getById dentro do laço.
  const bankAccountIdByPayable = new Map<string, string>();
  const documentNumberByPayable = new Map<string, string>();

  await Promise.all(
    payables.map(async (p) => {
      const pagamentos = await repos.payments.listByPayable(companyId, p.id);
      // O pagamento executado manda; sem ele, o agendado mais recente.
      const executado = pagamentos.find((pg) => pg.status === "executed");
      const relevante = executado ?? pagamentos.find((pg) => pg.status !== "canceled");
      if (relevante) bankAccountIdByPayable.set(p.id, relevante.bankAccountId);

      if (p.documentId) {
        const doc = await repos.documents.getById(companyId, p.documentId);
        if (doc) documentNumberByPayable.set(p.id, doc.series ? `${doc.number}/${doc.series}` : doc.number);
      }
    })
  );

  return {
    payables,
    lookups: {
      suppliers,
      costCenters,
      bankAccounts,
      bankAccountIdByPayable,
      documentNumberByPayable,
    },
    supplierNameFiltrado: filtros.supplierId
      ? suppliers.find((s) => s.id === filtros.supplierId)?.name
      : undefined,
    truncado: page.total > payables.length,
  };
}
