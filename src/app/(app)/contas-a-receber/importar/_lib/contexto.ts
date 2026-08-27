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
  const [customers, categories, costCenters, receivables] = await Promise.all([
    repos.customers.listAll(companyId),
    repos.categories.listAll(companyId),
    repos.costCenters.listAll(companyId),
    repos.receivables.listAll(companyId),
  ]);

  // Nº do documento por título: um lote só, para a checagem de duplicidade não
  // virar uma consulta por linha do CSV.
  const documentNumberByReceivable = new Map<string, string>();
  const comDocumento = receivables.filter((r) => r.documentId);
  await Promise.all(
    comDocumento.map(async (r) => {
      const doc = await repos.documents.getById(companyId, r.documentId!);
      if (doc) documentNumberByReceivable.set(r.id, doc.number);
    })
  );

  return { customers, categories, costCenters, receivables, documentNumberByReceivable };
}
