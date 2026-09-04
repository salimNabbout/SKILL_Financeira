/**
 * Registro de atividade do usuário (telemetria de auditoria).
 * Difere da trilha AuditTrail: alto volume, sem cadeia de hash e com política
 * de retenção possível. Regra de ouro: registrar atividade NUNCA pode derrubar
 * a ação principal — record() engole qualquer falha de persistência.
 */

import type { ActivityEvent, ID } from "./entities";
import type { ActivityEventRepo } from "./repositories";
import type { Clock } from "./clock";
import type { IdGenerator } from "./ids";

export interface ActivityEntry {
  userId?: ID;
  origin: ActivityEvent["origin"];
  eventType: string;
  screen?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  userAgent?: string;
  label?: string;
  elementId?: string;
  details?: unknown;
  /** Momento do evento no cliente (ISO completo); ausente/inválido → agora. */
  timestamp?: string;
}

/** Campos cujo NOME indica segredo — o valor nunca é gravado. */
const SENSITIVE_KEY_RE = /senha|password|token|secret|cart[aã]o|card/i;
const MASK = "***";

// Limites de volume por evento (telemetria, não dump de dados).
const MAX_STRING = 300;
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_KEYS = 30;

/**
 * Sanitiza o complemento livre de um evento: mascara valores de chaves
 * sensíveis (senha/password/token/secret/cartão), trunca strings longas e
 * limita profundidade/tamanho de objetos e arrays.
 */
export function sanitizeActivityDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return MASK;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => sanitizeActivityDetails(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? MASK : sanitizeActivityDetails(v, depth + 1);
    }
    return out;
  }
  // function/symbol/bigint não são serializáveis em Json — descarta.
  return undefined;
}

const truncate = (v: string | undefined, max: number): string | undefined =>
  v === undefined ? undefined : v.length > max ? v.slice(0, max) : v;

// Aceita apenas ISO completo com "Z"/offset e dentro de uma janela sã (relógio
// de cliente pode estar errado): até 24h no passado e 5min no "futuro".
function clientTimestamp(raw: string | undefined, now: Date): string | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const delta = now.getTime() - parsed.getTime();
  if (delta < -5 * 60_000 || delta > 24 * 60 * 60_000) return undefined;
  return parsed.toISOString();
}

export class ActivityLog {
  constructor(
    private readonly repo: ActivityEventRepo,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  /** Grava um evento; qualquer falha é engolida (log no console) — nunca lança. */
  async record(companyId: ID, entry: ActivityEntry): Promise<void> {
    try {
      const now = this.clock.now();
      const event: ActivityEvent = {
        id: this.ids.next("act"),
        companyId,
        userId: entry.userId,
        origin: entry.origin,
        eventType: truncate(entry.eventType, 60) ?? "desconhecido",
        screen: truncate(entry.screen, 300),
        method: truncate(entry.method, 10),
        path: truncate(entry.path, 300),
        status: entry.status,
        durationMs: entry.durationMs,
        ip: truncate(entry.ip, 60),
        userAgent: truncate(entry.userAgent, 300),
        label: truncate(entry.label, 160),
        elementId: truncate(entry.elementId, 160),
        details: entry.details === undefined ? undefined : sanitizeActivityDetails(entry.details),
        timestamp: clientTimestamp(entry.timestamp, now) ?? now.toISOString(),
      };
      await this.repo.append(event);
    } catch (error) {
      // Telemetria jamais derruba a ação principal.
      console.error("[atividade] falha ao registrar evento (ignorada):", error);
    }
  }
}
