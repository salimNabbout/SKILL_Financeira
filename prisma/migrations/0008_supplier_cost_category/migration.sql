-- Fornecedor: classificação de custo (fixo/variável) e categoria livre.
-- Colunas opcionais e aditivas — fornecedores existentes ficam com NULL.
ALTER TABLE "Supplier" ADD COLUMN "costClassification" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "category" TEXT;
