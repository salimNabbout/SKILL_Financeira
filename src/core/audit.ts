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
    await this.repo.append(record);
    return record;
  }
}

/** Verifica a integridade da cadeia; retorna o primeiro registro adulterado, se houver. */
export function verifyChain(records: AuditRecord[]): { valid: boolean; brokenAtSeq?: number } {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  let prevHash = AUDIT_GENESIS_HASH;
  for (const record of sorted) {
    const { hash, ...rest } = record;
    if (record.prevHash !== prevHash || computeAuditHash(prevHash, rest) !== hash) {
      return { valid: false, brokenAtSeq: record.seq };
    }
    prevHash = hash;
  }
  return { valid: true };
}
