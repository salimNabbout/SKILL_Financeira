/**
 * Contrato padrão de resposta de todas as skills.
 * Formato exigido pela especificação do produto — não alterar sem versionar.
 */

export type SkillStatus = "success" | "warning" | "error" | "awaiting_approval";

export type AlertSeverity = "info" | "warning" | "critical";

export interface SkillAlert {
  severity: AlertSeverity;
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export interface PendingItem {
  code: string;
  description: string;
  entityType?: string;
  entityId?: string;
  suggestedAction?: string;
}

export interface SkillAuditInfo {
  execution_id: string;
  timestamp: string; // ISO-8601 UTC
  data_sources: string[];
}

export interface SkillResult<T = unknown> {
  skill: string;
  status: SkillStatus;
  /** 0.0 a 1.0 — cálculos determinísticos usam 1.0; heurísticas/estimativas, menos. */
  confidence: number;
  data: T;
  alerts: SkillAlert[];
  pending_items: PendingItem[];
  /** Suposições explícitas feitas durante a execução (dados faltantes, defaults). */
  assumptions: string[];
  requires_human_approval: boolean;
  audit: SkillAuditInfo;
}

/** Referência de aprovação pendente que uma skill devolve ao orquestrador. */
export interface ApprovalRequestData {
  targetType: "payment" | "collection_message" | "bank_change" | "deletion" | "flow_step";
  targetId: string;
  summary: string;
  amountCents?: number;
  /**
   * Valor usado para determinar a ALÇADA de aprovação (papel e nº de aprovações).
   * Quando ausente, cai em amountCents. Serve para que um pagamento fracionado
   * não reduza a alçada exigida: a skill informa aqui o valor do TÍTULO inteiro.
   */
  tierAmountCents?: number;
}
