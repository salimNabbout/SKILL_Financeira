/**
 * Trilha de auditoria imutável.
 * Cada registro encadeia o hash do anterior: hash = sha256(prevHash + canonicalJson(conteúdo)).
 * Qualquer adulteração quebra a cadeia e é detectável por verifyChain().
 */

import { createHash } from "node:crypto";
import type { Actor, AuditRecord, ID } from "./entities";
import type { AuditRepo } from "./repositories";
import type { Clock } from "./clock";
import { canonicalJson, type IdGenerator } from "./ids";

export interface AuditEntry {
  actor: Actor;
  action: string;
  entityType: string;
  entityId: ID;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
}

export interface AuditTrail {
  record(companyId: ID, entry: AuditEntry): Promise<AuditRecord>;
}

export function computeAuditHash(prevHash: string, record: Omit<AuditRecord, "hash">): string {
  const content = canonicalJson({
    seq: record.seq,
    companyId: record.companyId,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    before: record.before ?? null,
    after: record.after ?? null,
    correlationId: record.correlationId ?? null,
    timestamp: record.timestamp,
  });
  return createHash("sha256").update(prevHash).update(content).digest("hex");
}

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export class HashChainAuditTrail implements AuditTrail {
  constructor(
    private readonly repo: AuditRepo,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  async record(companyId: ID, entry: AuditEntry): Promise<AuditRecord> {
    // Duas escritas concorrentes podem ler o mesmo head e computar o mesmo seq.
    // O append rejeita o seq duplicado (unique (companyId, seq) no Postgres;
    // mesma checagem no adaptador em memória) — aqui reobtemos o head e
    // refazemos, evitando bifurcar/colidir a cadeia.
    const MAX_ATTEMPTS = 5;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const last = await this.repo.last(companyId);
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? AUDIT_GENESIS_HASH;
      const partial: Omit<AuditRecord, "hash"> = {
        id: this.ids.next("aud"),
        companyId,
        seq,
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        correlationId: entry.correlationId,
        timestamp: this.clock.now().toISOString(),
        prevHash,
      };
      const record: AuditRecord = { ...partial, hash: computeAuditHash(prevHash, partial) };
      try {
        await this.repo.append(record);
        return record;
      } catch (error) {
        lastError = error;
        // Tenta de novo: o próximo last() já refletirá o head vencedor.
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Falha ao registrar auditoria após múltiplas tentativas.");
  }
}

/**
 * Verifica a integridade da cadeia; retorna o primeiro registro adulterado, se
 * houver. Adulteração de CONTEÚDO e truncamento do INÍCIO/MEIO são detectados
 * pelo encadeamento de hashes (a cadeia deve começar no genesis e ser contígua).
 *
 * O truncamento do FIM (remover os últimos registros) não é detectável só pelos
 * dados presentes — passe `expectedHead` (seq e hash do último registro
 * conhecido, guardado à parte) para detectá-lo.
 */
export function verifyChain(
  records: AuditRecord[],
  expectedHead?: { seq: number; hash: string }
): { valid: boolean; brokenAtSeq?: number } {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  let prevHash = AUDIT_GENESIS_HASH;
  for (const record of sorted) {
    const { hash, ...rest } = record;
    if (record.prevHash !== prevHash || computeAuditHash(prevHash, rest) !== hash) {
      return { valid: false, brokenAtSeq: record.seq };
    }
    prevHash = hash;
  }

  if (expectedHead) {
    const actualHead = sorted[sorted.length - 1];
    // Head ausente (cadeia vazia) ou aquém do esperado ⇒ truncamento do fim.
    if (!actualHead || actualHead.seq !== expectedHead.seq || actualHead.hash !== expectedHead.hash) {
      return { valid: false, brokenAtSeq: expectedHead.seq };
    }
  }

  return { valid: true };
}
