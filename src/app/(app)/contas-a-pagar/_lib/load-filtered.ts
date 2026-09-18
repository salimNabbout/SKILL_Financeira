/**
 * Carrega TODOS os títulos que atendem aos filtros — sem paginação — junto dos
 * dados auxiliares para exportar e imprimir.
 *
 * A listagem da tela usa `listPage` por volumetria; exportação e impressão
 * precisam do conjunto inteiro, senão o arquivo sairia com uma página só e
 * ninguém notaria até somar os totais.
 */

import { todayInTz, type ISODate } from "@/core/dates";
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

/**
 * `timeZone` (fuso da empresa) liga o cálculo da data de pagamento por título:
 * a MAIOR data de conciliação entre os pagamentos executados, convertida do
 * executedAt (UTC) para a data local — a mesma regra do badge de situação da
 * tela. Sem fuso (impressão), a data não é calculada.
 */
export async function loadFilteredPayables(
  repos: Repositories,
  companyId: string,
  filtros: PayableFilters,
  timeZone?: string
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
  const paymentDateByPayable = new Map<string, ISODate>();

  await Promise.all(
    payables.map(async (p) => {
      const pagamentos = await repos.payments.listByPayable(companyId, p.id);
      // O pagamento executado manda; sem ele, o agendado mais recente.
      const executado = pagamentos.find((pg) => pg.status === "executed");
      const relevante = executado ?? pagamentos.find((pg) => pg.status !== "canceled");
      if (relevante) bankAccountIdByPayable.set(p.id, relevante.bankAccountId);

      if (timeZone) {
        for (const pg of pagamentos) {
          if (pg.status !== "executed" || !pg.executedAt) continue;
          const localDate = todayInTz(new Date(pg.executedAt), timeZone);
          const prev = paymentDateByPayable.get(p.id);
          if (!prev || localDate > prev) paymentDateByPayable.set(p.id, localDate);
        }
      }

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
      paymentDateByPayable,
    },
    supplierNameFiltrado: filtros.supplierId
      ? suppliers.find((s) => s.id === filtros.supplierId)?.name
      : undefined,
    truncado: page.total > payables.length,
  };
}
