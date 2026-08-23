-- Remove a forma de pagamento (method) do fluxo de Contas a Pagar.
-- Afeta APENAS a tabela Payment; o `method` de Receivable/Receipt (contas a
-- receber) é um enum distinto e permanece intacto.
ALTER TABLE "Payment" DROP COLUMN "method";
