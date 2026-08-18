-- Índices para listagens paginadas ordenadas por vencimento (volumetria).
CREATE INDEX "Payable_companyId_dueDate_idx" ON "Payable"("companyId", "dueDate");
CREATE INDEX "Receivable_companyId_dueDate_idx" ON "Receivable"("companyId", "dueDate");
