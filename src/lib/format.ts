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
