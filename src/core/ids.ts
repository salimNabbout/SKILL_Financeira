import { createHash, randomUUID } from "node:crypto";

/** Gerador de identificadores injetável (determinístico em testes). */
export interface IdGenerator {
  next(prefix: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

/** IDs sequenciais previsíveis para testes: pay_0001, pay_0002... */
export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }
}

/** Hash canônico (sha256 hex) de um payload JSON — usado para idempotência. */
export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Serialização JSON com chaves ordenadas (estável para hashing). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
