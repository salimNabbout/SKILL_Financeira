/**
 * Dados de referência para validar a importação: cadastros existentes e os
 * documentos já lançados (para marcar duplicidade).
 */

import type { Repositories } from "@/core/repositories";
import type { ImportContext } from "../../_lib/import-csv";

export async function carregarContextoImportacao(
  repos: Repositories,
  companyId: string
): Promise<ImportContext> {
  const [suppliers, categories, costCenters, payables] = await Promise.all([
    repos.suppliers.listAll(companyId),
    repos.supplierCategories.listAll(companyId),
    repos.costCenters.listAll(companyId),
    repos.payables.listAll(companyId),
  ]);

  // Nº do documento por título: um lote só, para a checagem de duplicidade não
  // virar uma consulta por linha do CSV.
  const documentNumberByPayable = new Map<string, string>();
  const comDocumento = payables.filter((p) => p.documentId);
  await Promise.all(
    comDocumento.map(async (p) => {
      const doc = await repos.documents.getById(companyId, p.documentId!);
      if (doc) documentNumberByPayable.set(p.id, doc.number);
    })
  );

  return { suppliers, categories, costCenters, payables, documentNumberByPayable };
}
