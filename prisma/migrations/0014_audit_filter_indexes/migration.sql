-- Índices para os filtros da tela de Auditoria: por período (timestamp) e por
-- ator. O índice (companyId, entityType, entityId) já existe desde 0001 e
-- cobre o filtro por entidade; o filtro por ação usa o (companyId) + varredura.
CREATE INDEX "AuditRecord_companyId_timestamp_idx" ON "AuditRecord"("companyId", "timestamp");
CREATE INDEX "AuditRecord_companyId_actorId_idx" ON "AuditRecord"("companyId", "actorId");
