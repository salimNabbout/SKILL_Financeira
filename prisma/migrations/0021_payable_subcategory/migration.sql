-- Contas a pagar: caixa "Subcategoria" no formulário "Novo título".
--
-- Texto livre e opcional, gravado no título no momento do lançamento. Coluna
-- nula por padrão: títulos existentes não mudam.
ALTER TABLE "Payable" ADD COLUMN "subcategory" TEXT;
