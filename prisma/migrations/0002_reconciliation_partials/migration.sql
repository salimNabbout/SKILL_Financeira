-- Baixas parciais e rateio na conciliação:
-- amountCents = porção da transação aplicada ao alvo (null = integral);
-- groupId = matches decididos em conjunto (rateio multi-parcela / transferência).
ALTER TABLE "ReconciliationMatch" ADD COLUMN "amountCents" BIGINT;
ALTER TABLE "ReconciliationMatch" ADD COLUMN "groupId" TEXT;
