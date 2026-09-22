-- Cadastro "Subcategoria a PAGAR": lista que alimenta a caixa SUBCATEGORIA do
-- formulário "Novo título" em Contas a pagar (mesmo desenho de SupplierCategory:
-- nome em Title Case, único por empresa, referenciado por NOME em Payable.subcategory).
CREATE TABLE "PayableSubcategory" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayableSubcategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayableSubcategory_companyId_name_key" ON "PayableSubcategory"("companyId", "name");
CREATE INDEX "PayableSubcategory_companyId_idx" ON "PayableSubcategory"("companyId");

ALTER TABLE "PayableSubcategory" ADD CONSTRAINT "PayableSubcategory_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
