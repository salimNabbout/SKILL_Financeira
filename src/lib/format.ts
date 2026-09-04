/** Formatação pt-BR compartilhada pela UI. */

import { formatBR, type ISODate } from "@/core/dates";
import { formatBRL } from "@/core/money";

export { formatBR, formatBRL };

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function formatDateOrDash(date?: ISODate): string {
  return date ? formatBR(date) : "—";
}

export const STATUS_LABELS: Record<string, string> = {
  open: "Em aberto",
  scheduled: "Agendado",
  partially_paid: "Pago parcial",
  paid: "Pago",
  partially_received: "Recebido parcial",
  received: "Recebido",
  canceled: "Cancelado",
  pending_approval: "Aguardando aprovação",
  approved: "Aprovado",
  executed: "Executado",
  rejected: "Rejeitado",
  pending: "Pendente",
  expired: "Expirado",
  auto_confirmed: "Conciliado (auto)",
  suggested: "Sugerido",
  confirmed: "Conciliado",
  draft: "Rascunho",
  issued: "Emitida",
  awaiting_approval: "Aguardando aprovação",
  sent: "Enviada",
  running: "Em execução",
  completed: "Concluído",
  failed: "Falhou",
  success: "Sucesso",
  warning: "Atenção",
  error: "Erro",
  info: "Info",
  critical: "Crítico",
  acknowledged: "Reconhecido",
  resolved: "Resolvido",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador(a)",
  finance_manager: "Gestor(a) financeiro(a)",
  approver: "Aprovador(a)",
  finance_analyst: "Analista financeiro(a)",
  accountant: "Contador(a)",
  viewer: "Visualização",
};

/**
 * Rótulos de EXIBIÇÃO das ações da trilha de auditoria (coluna AÇÃO). Os
 * códigos (ex.: "payable.settled_via_reconciliation") são identificadores de
 * máquina — já gravados no banco, usados em testes — e NÃO devem ser
 * renomeados; este mapa traduz só para a tela. A tela usa
 * `ACTION_LABELS[r.action] ?? r.action` (fallback obrigatório para ações
 * futuras). Um teste (src/lib/__tests__/action-labels.test.ts) garante que
 * toda ação real do código tem entrada aqui.
 */
export const ACTION_LABELS: Record<string, string> = {
  // Acesso e usuários
  "auth.login": "Login realizado",
  "auth.login_failed": "Tentativa de login sem sucesso",
  "auth.logout": "Sessão encerrada",
  "auth.switch_company": "Empresa ativa trocada",
  "user.created": "Usuário criado",
  "user.password_changed": "Senha alterada",
  "user.password_reset": "Senha redefinida pelo administrador",
  "user.deactivated": "Usuário desativado",
  "user.reactivated": "Usuário reativado",
  "user.totp_setup_started": "Segredo de duas etapas gerado",
  "user.totp_enabled": "Verificação em duas etapas ativada",
  "user.totp_disabled": "Verificação em duas etapas desativada",
  "membership.created": "Acesso de usuário concedido",
  "membership.updated": "Acesso de usuário alterado",

  // Cadastros
  "supplier.created": "Fornecedor cadastrado",
  "supplier.updated": "Fornecedor alterado",
  "supplier.deleted": "Fornecedor excluído",
  "supplier_category.created": "Categoria de fornecedor criada",
  "supplier_category.updated": "Categoria de fornecedor alterada",
  "customer.created": "Cliente cadastrado",
  "category.created": "Categoria criada",
  "cost_center.created": "Centro de custo criado",
  "chart_account.created": "Conta contábil criada",
  "bank_account.created": "Conta bancária cadastrada",
  "recurring_template.created": "Recorrência criada",
  "recurring_template.updated": "Recorrência alterada",
  // Rótulos PREPARADOS: a operação de editar/excluir/desativar destes cadastros
  // ainda não existe (hoje são create-only). Deixados aqui para quando o
  // audit.record correspondente for adicionado — não quebram o guard (que
  // exige ação→rótulo, não rótulo→ação).
  "customer.updated": "Cliente alterado",
  "customer.deleted": "Cliente excluído",
  "category.updated": "Categoria alterada",
  "category.deleted": "Categoria excluída",
  "cost_center.updated": "Centro de custo alterado",
  "cost_center.deactivated": "Centro de custo desativado",
  "cost_center.reactivated": "Centro de custo reativado",
  "chart_account.updated": "Conta contábil alterada",
  "chart_account.deactivated": "Conta contábil desativada",
  "bank_account.updated": "Conta bancária alterada",
  "bank_account.deactivated": "Conta bancária desativada",
  "supplier_category.deleted": "Categoria de fornecedor excluída",

  // Contas a pagar e pagamentos
  "document.created": "Documento fiscal registrado",
  "payable.created": "Título a pagar criado",
  "payable.updated": "Título a pagar alterado",
  "payable.due_date_adjusted": "Vencimento do título corrigido",
  "payable.canceled": "Título a pagar cancelado",
  "payable.settled_via_reconciliation": "Título baixado pela conciliação",
  "payment.requested": "Pagamento solicitado",
  "payment.approved": "Pagamento aprovado",
  "payment.executed": "Pagamento executado (conciliado)",
  "payment.rejected": "Pagamento rejeitado",
  "payment.canceled": "Pagamento cancelado",
  "payment.reversed": "Pagamento estornado",
  "payment.date_adjusted": "Data do pagamento corrigida",
  "approval.reverted": "Aprovação estornada",
  "accounting.entries_reversed": "Lançamento contábil estornado",
  "accounting.entry_date_corrected": "Data do lançamento contábil corrigida",

  // Contas a receber e recebimentos
  "receivable.created": "Título a receber criado",
  "receivable.updated": "Título a receber alterado",
  "receivable.canceled": "Título a receber cancelado",
  "receivable.receipt_registered": "Recebimento registrado",
  "receivable.charge_issued": "Cobrança emitida",
  "receipt.created": "Recebimento criado",
  "receipt.reversed": "Recebimento estornado",
  "receipt.date_adjusted": "Data do recebimento corrigida",

  // Notas fiscais
  "invoice.created": "Nota fiscal criada",
  "invoice.issued": "Nota fiscal emitida",
  "invoice.canceled": "Nota fiscal cancelada",

  // Empresa
  "company.created": "Empresa criada",
  "company.updated": "Empresa alterada",

  // Conciliação bancária
  "statement.imported": "Extrato importado",
  "statement.synced": "Extrato sincronizado",
  "bank_transaction.reconciled": "Transação bancária conciliada",
  "bank_transaction.unreconciled": "Conciliação de transação desfeita",
  "reconciliation.auto_matched": "Conciliação automática",
  "reconciliation.suggested": "Conciliação sugerida",
  "reconciliation.confirmed": "Conciliação confirmada",
  "reconciliation.rejected": "Conciliação rejeitada",

  // Cobrança
  "collection.message_drafted": "Mensagem de cobrança preparada",
  "collection.message_sent": "Mensagem de cobrança enviada",
  "collection.message_canceled": "Mensagem de cobrança cancelada",

  // Aprovações
  "approval.requested": "Aprovação solicitada",
  "approval.partially_approved": "Aprovação parcial registrada",
  "approval.approved": "Aprovação concedida",
  "approval.rejected": "Aprovação rejeitada",

  // Alertas e controles
  "alert.created": "Alerta gerado",
  "alert.acknowledged": "Alerta reconhecido",
  "controls.violation_detected": "Violação de controle detectada",

  // Orçamento
  "budget.created": "Orçamento criado",
  "budget.updated": "Orçamento alterado",

  // Contabilidade
  "accounting.entry_prepared": "Lançamento contábil preparado",
  "accounting.entry_exported": "Lançamento contábil exportado",
  "accounting.batch_exported": "Lote contábil exportado",

  // Relatórios e processos
  "report.generated": "Relatório gerado",
  "flow.started": "Fluxo iniciado",
  "flow.completed": "Fluxo concluído",
  "flow.failed": "Fluxo interrompido por erro",
  "flow.reaped": "Fluxo travado liberado pelo sistema",
  "audit.exported": "Trilha de auditoria exportada",
};
