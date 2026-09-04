-- Estorno de recebimento: o padrão do app é cancelamento LÓGICO (nada auditado
-- é apagado), e Receipt não tinha onde registrar isso.
--
-- principalCents existe porque Receipt.amountCents é o valor TOTAL recebido
-- (principal + multa/juros) e só o PRINCIPAL baixa o saldo do título. Sem
-- guardá-lo, o estorno não teria como devolver o valor certo. Nulo nas linhas
-- antigas: nelas o estorno cai no fallback (mínimo entre o total e o saldo
-- baixado), exato sempre que não houve encargo.
ALTER TABLE "Receipt" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'registered';
ALTER TABLE "Receipt" ADD COLUMN "canceledAt" TIMESTAMP(3);
ALTER TABLE "Receipt" ADD COLUMN "principalCents" BIGINT;

CREATE INDEX "Receipt_companyId_status_idx" ON "Receipt"("companyId", "status");
