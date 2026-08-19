import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../rate-limit";

describe("InMemoryRateLimiter", () => {
  it("permite até o limite e bloqueia a tentativa seguinte na mesma janela", () => {
    let now = 1_000_000;
    const rl = new InMemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000, now: () => now });

    expect(rl.check("ip:a@x.com").allowed).toBe(true);
    expect(rl.check("ip:a@x.com").allowed).toBe(true);
    expect(rl.check("ip:a@x.com").allowed).toBe(true);
    const blocked = rl.check("ip:a@x.com");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("libera após a janela expirar", () => {
    let now = 0;
    const rl = new InMemoryRateLimiter({ maxAttempts: 2, windowMs: 10_000, now: () => now });
    rl.check("k");
    rl.check("k");
    expect(rl.check("k").allowed).toBe(false);

    now += 10_001; // janela passou
    expect(rl.check("k").allowed).toBe(true);
  });

  it("isola chaves diferentes", () => {
    let now = 0;
    const rl = new InMemoryRateLimiter({ maxAttempts: 1, windowMs: 10_000, now: () => now });
    expect(rl.check("k1").allowed).toBe(true);
    expect(rl.check("k1").allowed).toBe(false);
    // Outra chave não é afetada.
    expect(rl.check("k2").allowed).toBe(true);
  });

  it("reset limpa o contador de uma chave (ex.: após login bem-sucedido)", () => {
    let now = 0;
    const rl = new InMemoryRateLimiter({ maxAttempts: 2, windowMs: 10_000, now: () => now });
    rl.check("k");
    rl.check("k");
    expect(rl.check("k").allowed).toBe(false);
    rl.reset("k");
    expect(rl.check("k").allowed).toBe(true);
  });
});
