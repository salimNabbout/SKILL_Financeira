-- Lote de importação de extrato.
--
-- Motivo: as transações sozinhas não dizem QUANDO cada arquivo entrou nem qual
-- saldo o BANCO declarava naquele momento. O OFX traz esse saldo em
-- <LEDGERBAL> e o parser lia e descartava — é a única referência externa para
-- conferir o saldo calculado pelo app.
--
-- O id é o mesmo valor já gravado em "BankTransaction"."importBatchId", então
-- dá para ir do lançamento ao lote sem coluna nova na tabela de transações.
-- Nenhum backfill: lotes anteriores a esta migração não têm registro, e a
-- auditoria trata a ausência como "sem saldo de referência".

CREATE TABLE "StatementImport" (
    "id"                 TEXT NOT NULL,
    "companyId"          TEXT NOT NULL,
    "bankAccountId"      TEXT NOT NULL,
    "format"             TEXT NOT NULL,
    "source"             TEXT NOT NULL,
    "imported"           INTEGER NOT NULL,
    "duplicates"         INTEGER NOT NULL,
    "warnings"           TEXT[],
    "ledgerBalanceCents" BIGINT,
    "ledgerBalanceDate"  DATE,
    "createdBy"          TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- A auditoria pergunta sempre "último lote desta conta desta empresa": o índice
-- cobre o filtro e a ordenação por data.
CREATE INDEX "StatementImport_companyId_bankAccountId_createdAt_idx"
    ON "StatementImport"("companyId", "bankAccountId", "createdAt");

ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
