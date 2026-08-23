-- Índice para o filtro por fornecedor em Contas a Pagar.
-- O índice (companyId, dueDate) já existe desde 0003_pagination_indexes, então
-- NÃO é recriado aqui (o filtro por intervalo de vencimento o reaproveita).
CREATE INDEX "Payable_companyId_supplierId_idx" ON "Payable"("companyId", "supplierId");
