-- Recorrência mensal de títulos: template cadastrado uma vez; o scheduler gera
-- o título do mês (a pagar ou a receber) automaticamente no vencimento (dueDay).
CREATE TABLE "RecurringTemplate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "counterpartyId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amountCents" BIGINT NOT NULL,
  "dueDay" INTEGER NOT NULL,
  "category" TEXT,
  "costClassification" TEXT,
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecurringTemplate_companyId_idx" ON "RecurringTemplate"("companyId");
CREATE INDEX "RecurringTemplate_companyId_status_idx" ON "RecurringTemplate"("companyId", "status");

ALTER TABLE "RecurringTemplate" ADD CONSTRAINT "RecurringTemplate_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
