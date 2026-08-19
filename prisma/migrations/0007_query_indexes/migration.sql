-- Índices para as consultas por FK que os repositórios já fazem (Postgres não
-- indexa FK automaticamente). Melhora conciliação e detalhes de título/recibo.
CREATE INDEX "Payment_companyId_payableId_idx" ON "Payment"("companyId", "payableId");
CREATE INDEX "Receipt_companyId_receivableId_idx" ON "Receipt"("companyId", "receivableId");
CREATE INDEX "Receivable_companyId_customerId_idx" ON "Receivable"("companyId", "customerId");
CREATE INDEX "ReconciliationMatch_companyId_bankTransactionId_idx" ON "ReconciliationMatch"("companyId", "bankTransactionId");
CREATE INDEX "EventRecord_companyId_occurredAt_idx" ON "EventRecord"("companyId", "occurredAt");
CREATE INDEX "FlowRun_companyId_approvalId_idx" ON "FlowRun"("companyId", "approvalId");
