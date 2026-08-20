-- Categoria de fornecedores cadastrável (lista que alimenta o campo CATEGORIA).
CREATE TABLE "SupplierCategory" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierCategory_companyId_name_key" ON "SupplierCategory"("companyId", "name");
CREATE INDEX "SupplierCategory_companyId_idx" ON "SupplierCategory"("companyId");

ALTER TABLE "SupplierCategory" ADD CONSTRAINT "SupplierCategory_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
