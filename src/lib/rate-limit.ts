/**
 * Limitador de tentativas em memória (por processo) — janela deslizante simples.
 * Usado no login para conter brute-force. Determinístico via `now` injetável.
 *
 * Limitação conhecida: o estado é por processo. Em produção multi-instância,
 * cada réplica conta em separado; um limitador distribuído (Redis) seria a
 * evolução. Ainda assim, reduz drasticamente o custo de brute-force por réplica.
 */

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Quando bloqueado, tempo em ms até a janela liberar. */
  retryAfterMs?: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class InMemoryRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimitOptions) {
    this.maxAttempts = options.maxAttempts;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Registra uma tentativa para a chave e diz se é permitida. */
  check(key: string): RateLimitResult {
    const t = this.now();
    const bucket = this.buckets.get(key);

    if (!bucket || t - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: t });
      return { allowed: true };
    }

    if (bucket.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: this.windowMs - (t - bucket.windowStart) };
    }

    bucket.count += 1;
    return { allowed: true };
  }

  /** Zera o contador de uma chave (ex.: após autenticação bem-sucedida). */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}
