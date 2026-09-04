/**
 * Catálogo canônico de `action` e `entityType` da trilha de auditoria.
 *
 * Existiam DUAS convenções em paralelo: as server actions da UI emitiam
 * snake_case minúsculo (`cost_center.created`, `entityType: "payable"`),
 * enquanto a API emitia o nome da entidade em PascalCase (`entityType:
 * "Supplier"`) e derivava a ação com `toLowerCase()` — produzindo
 * `costcenter.created` e `bankaccount.created`. O mesmo fato virava dois
 * registros diferentes, e os filtros da tela /auditoria não achavam ambos.
 *
 * Convenção única: **snake_case minúsculo**, `entidade.verbo_no_particípio`.
 *
 * Registros ANTIGOS não são reescritos — isso quebraria a cadeia de hash. Os
 * nomes legados são normalizados na LEITURA (ver `canonicalAction` /
 * `canonicalEntityType`), para que o filtro encontre os dois.
 */

/** Tipos de entidade auditáveis. */
export const AUDIT_ENTITIES = {
  ALERT: "alert",
  APPROVAL: "approval",
  AUDIT_EXPORT: "audit_export",
  BANK_ACCOUNT: "bank_account",
  CATEGORY: "category",
  COMPANY: "company",
  COST_CENTER: "cost_center",
  CUSTOMER: "customer",
  DOCUMENT: "document",
  FLOW_RUN: "flow_run",
  MEMBERSHIP: "membership",
  PAYABLE: "payable",
  PAYMENT: "payment",
  RECEIPT: "receipt",
  RECEIVABLE: "receivable",
  SUPPLIER: "supplier",
  SUPPLIER_CATEGORY: "supplier_category",
  USER: "user",
  ACCOUNTING_ENTRY: "accounting_entry",
  BANK_TRANSACTION: "bank_transaction",
  BUDGET: "budget",
  CHART_ACCOUNT: "chart_account",
  COLLECTION_MESSAGE: "collection_message",
  INVOICE: "invoice",
  RECONCILIATION_MATCH: "reconciliation_match",
  RECURRING_TEMPLATE: "recurring_template",
  REPORT: "report",
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];

/** Ações da trilha. O nome NUNCA muda depois de publicado (a trilha é histórica). */
export const AUDIT_ACTIONS = {
  // Acesso e usuários
  AUTH_LOGIN: "auth.login",
  AUTH_LOGIN_FAILED: "auth.login_failed",
  AUTH_LOGOUT: "auth.logout",
  AUTH_SWITCH_COMPANY: "auth.switch_company",
  USER_CREATED: "user.created",
  USER_PASSWORD_CHANGED: "user.password_changed",
  USER_PASSWORD_RESET: "user.password_reset",
  USER_DEACTIVATED: "user.deactivated",
  USER_REACTIVATED: "user.reactivated",
  USER_TOTP_SETUP_STARTED: "user.totp_setup_started",
  USER_TOTP_ENABLED: "user.totp_enabled",
  USER_TOTP_DISABLED: "user.totp_disabled",
  MEMBERSHIP_CREATED: "membership.created",
  MEMBERSHIP_UPDATED: "membership.updated",
  COMPANY_CREATED: "company.created",
  COMPANY_UPDATED: "company.updated",

  // Cadastros
  SUPPLIER_CREATED: "supplier.created",
  SUPPLIER_UPDATED: "supplier.updated",
  SUPPLIER_DELETED: "supplier.deleted",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_UPDATED: "customer.updated",
  CUSTOMER_DELETED: "customer.deleted",
  CATEGORY_CREATED: "category.created",
  CATEGORY_UPDATED: "category.updated",
  CATEGORY_DELETED: "category.deleted",
  COST_CENTER_CREATED: "cost_center.created",
  COST_CENTER_UPDATED: "cost_center.updated",
  COST_CENTER_DEACTIVATED: "cost_center.deactivated",
  COST_CENTER_REACTIVATED: "cost_center.reactivated",
  BANK_ACCOUNT_CREATED: "bank_account.created",
  BANK_ACCOUNT_UPDATED: "bank_account.updated",
  BANK_ACCOUNT_DEACTIVATED: "bank_account.deactivated",
  SUPPLIER_CATEGORY_CREATED: "supplier_category.created",
  SUPPLIER_CATEGORY_UPDATED: "supplier_category.updated",
  SUPPLIER_CATEGORY_DELETED: "supplier_category.deleted",

  // Documentos e títulos
  DOCUMENT_CREATED: "document.created",
  PAYABLE_CREATED: "payable.created",
  PAYABLE_UPDATED: "payable.updated",
  PAYABLE_CANCELED: "payable.canceled",
  PAYABLE_DUE_DATE_ADJUSTED: "payable.due_date_adjusted",
  RECEIVABLE_CREATED: "receivable.created",
  RECEIVABLE_UPDATED: "receivable.updated",
  RECEIVABLE_CANCELED: "receivable.canceled",
  RECEIVABLE_RECEIPT_REGISTERED: "receivable.receipt_registered",

  // Pagamentos e recebimentos
  PAYMENT_REQUESTED: "payment.requested",
  PAYMENT_APPROVED: "payment.approved",
  PAYMENT_EXECUTED: "payment.executed",
  PAYMENT_REJECTED: "payment.rejected",
  PAYMENT_CANCELED: "payment.canceled",
  PAYMENT_REVERSED: "payment.reversed",
  PAYMENT_DATE_ADJUSTED: "payment.date_adjusted",
  RECEIPT_CREATED: "receipt.created",
  RECEIPT_REVERSED: "receipt.reversed",
  RECEIPT_DATE_ADJUSTED: "receipt.date_adjusted",

  // Aprovações e fluxos
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_PARTIALLY_APPROVED: "approval.partially_approved",
  APPROVAL_APPROVED: "approval.approved",
  APPROVAL_REJECTED: "approval.rejected",
  APPROVAL_REVERTED: "approval.reverted",
  FLOW_STARTED: "flow.started",
  FLOW_COMPLETED: "flow.completed",
  FLOW_FAILED: "flow.failed",
  FLOW_REAPED: "flow.reaped",

  // Alertas
  ALERT_CREATED: "alert.created",
  ALERT_ACKNOWLEDGED: "alert.acknowledged",

  // Faturamento e cobrança
  INVOICE_CREATED: "invoice.created",
  INVOICE_ISSUED: "invoice.issued",
  INVOICE_CANCELED: "invoice.canceled",
  RECEIVABLE_CHARGE_ISSUED: "receivable.charge_issued",
  COLLECTION_MESSAGE_DRAFTED: "collection.message_drafted",
  COLLECTION_MESSAGE_SENT: "collection.message_sent",
  COLLECTION_MESSAGE_CANCELED: "collection.message_canceled",

  // Conciliação bancária
  STATEMENT_IMPORTED: "statement.imported",
  STATEMENT_SYNCED: "statement.synced",
  RECONCILIATION_SUGGESTED: "reconciliation.suggested",
  RECONCILIATION_AUTO_MATCHED: "reconciliation.auto_matched",
  RECONCILIATION_CONFIRMED: "reconciliation.confirmed",
  RECONCILIATION_REJECTED: "reconciliation.rejected",
  BANK_TRANSACTION_RECONCILED: "bank_transaction.reconciled",
  BANK_TRANSACTION_UNRECONCILED: "bank_transaction.unreconciled",
  PAYABLE_SETTLED_VIA_RECONCILIATION: "payable.settled_via_reconciliation",

  // Contabilidade
  ACCOUNTING_ENTRY_PREPARED: "accounting.entry_prepared",
  ACCOUNTING_ENTRY_EXPORTED: "accounting.entry_exported",
  ACCOUNTING_BATCH_EXPORTED: "accounting.batch_exported",
  ACCOUNTING_ENTRIES_REVERSED: "accounting.entries_reversed",
  ACCOUNTING_ENTRY_DATE_CORRECTED: "accounting.entry_date_corrected",
  CHART_ACCOUNT_CREATED: "chart_account.created",

  // Orçamento, controles e relatórios
  BUDGET_CREATED: "budget.created",
  BUDGET_UPDATED: "budget.updated",
  CONTROLS_VIOLATION_DETECTED: "controls.violation_detected",
  REPORT_GENERATED: "report.generated",
  RECURRING_TEMPLATE_CREATED: "recurring_template.created",
  RECURRING_TEMPLATE_UPDATED: "recurring_template.updated",

  // Auditoria
  AUDIT_EXPORTED: "audit.exported",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Nomes gravados por versões anteriores → nome canônico.
 *
 * A trilha é append-only e encadeada por hash: reescrever registros antigos
 * quebraria a verificação de integridade. Por isso a normalização acontece na
 * LEITURA — o filtro por `cost_center.created` também encontra os
 * `costcenter.created` gravados pela API antiga.
 */
export const LEGACY_ACTION_ALIASES: Readonly<Record<string, AuditAction>> = {
  "costcenter.created": AUDIT_ACTIONS.COST_CENTER_CREATED,
  "bankaccount.created": AUDIT_ACTIONS.BANK_ACCOUNT_CREATED,
  "suppliercategory.created": AUDIT_ACTIONS.SUPPLIER_CATEGORY_CREATED,
};

export const LEGACY_ENTITY_ALIASES: Readonly<Record<string, AuditEntityType>> = {
  Alert: AUDIT_ENTITIES.ALERT,
  Approval: AUDIT_ENTITIES.APPROVAL,
  AuditExport: AUDIT_ENTITIES.AUDIT_EXPORT,
  BankAccount: AUDIT_ENTITIES.BANK_ACCOUNT,
  Category: AUDIT_ENTITIES.CATEGORY,
  Company: AUDIT_ENTITIES.COMPANY,
  CostCenter: AUDIT_ENTITIES.COST_CENTER,
  Customer: AUDIT_ENTITIES.CUSTOMER,
  FlowRun: AUDIT_ENTITIES.FLOW_RUN,
  Membership: AUDIT_ENTITIES.MEMBERSHIP,
  Supplier: AUDIT_ENTITIES.SUPPLIER,
  User: AUDIT_ENTITIES.USER,
  // Já houve dois nomes para o documento fiscal.
  financial_document: AUDIT_ENTITIES.DOCUMENT,
};

/** Nome canônico de uma ação (aceita os legados gravados no passado). */
export function canonicalAction(action: string): string {
  return LEGACY_ACTION_ALIASES[action] ?? action;
}

/** Nome canônico de um tipo de entidade (aceita os legados). */
export function canonicalEntityType(entityType: string): string {
  return LEGACY_ENTITY_ALIASES[entityType] ?? entityType;
}

/**
 * Todos os nomes (canônico + legados) que devem casar com o filtro do valor
 * canônico informado — usado na leitura da tela de Auditoria.
 */
export function actionFilterAliases(action: string): string[] {
  const canonico = canonicalAction(action);
  const legados = Object.entries(LEGACY_ACTION_ALIASES)
    .filter(([, alvo]) => alvo === canonico)
    .map(([legado]) => legado);
  return [canonico, ...legados];
}

export function entityFilterAliases(entityType: string): string[] {
  const canonico = canonicalEntityType(entityType);
  const legados = Object.entries(LEGACY_ENTITY_ALIASES)
    .filter(([, alvo]) => alvo === canonico)
    .map(([legado]) => legado);
  return [canonico, ...legados];
}
