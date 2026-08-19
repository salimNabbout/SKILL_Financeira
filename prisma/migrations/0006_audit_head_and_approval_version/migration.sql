-- Âncora do head da trilha de auditoria (detecta truncamento do fim) e versão
-- otimista das aprovações (evita lost-update em dupla aprovação concorrente).

CREATE TABLE "AuditHead" (
  "companyId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "hash" TEXT NOT NULL,
  CONSTRAINT "AuditHead_pkey" PRIMARY KEY ("companyId")
);

ALTER TABLE "Approval" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
