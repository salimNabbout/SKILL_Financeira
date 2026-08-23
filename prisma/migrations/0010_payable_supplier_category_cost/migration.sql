-- Título a pagar: categoria de fornecedor (texto) e classificação de custo
-- (fixo/variável), espelhadas do fornecedor no momento da entrada.
-- Colunas opcionais e aditivas — títulos existentes ficam com NULL.
ALTER TABLE "Payable" ADD COLUMN "supplierCategory" TEXT;
ALTER TABLE "Payable" ADD COLUMN "costClassification" TEXT;
