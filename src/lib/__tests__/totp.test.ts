import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  verifyTotp,
  verifyTotpConsume,
  TOTP_STEP_SECONDS,
} from "../totp";

// Segredo dos vetores oficiais da RFC 6238 (ASCII "12345678901234567890").
const RFC_SECRET_B32 = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("totp / base32 (RFC 4648)", () => {
  it("codifica o segredo da RFC e faz round-trip de bytes arbitrários", () => {
    expect(RFC_SECRET_B32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const data = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
    expect(base32Decode(base32Encode(data))).toEqual(data);
    // Aceita minúsculas e padding.
    expect(base32Decode("gezdgnbv")).toEqual(base32Decode("GEZDGNBV===="));
    expect(() => base32Decode("ABC!")).toThrow(/inválido/);
  });
});

describe("totp / RFC 6238 (vetores oficiais, HMAC-SHA1)", () => {
  it("gera os códigos de 8 dígitos dos vetores da RFC", () => {
    expect(totpCode(RFC_SECRET_B32, 59, 30, 8)).toBe("94287082");
    expect(totpCode(RFC_SECRET_B32, 1111111109, 30, 8)).toBe("07081804");
    expect(totpCode(RFC_SECRET_B32, 1111111111, 30, 8)).toBe("14050471");
    expect(totpCode(RFC_SECRET_B32, 1234567890, 30, 8)).toBe("89005924");
    expect(totpCode(RFC_SECRET_B32, 2000000000, 30, 8)).toBe("69279037");
  });

  it("padrão de 6 dígitos (apps autenticadores) é o sufixo dos vetores", () => {
    expect(totpCode(RFC_SECRET_B32, 59)).toBe("287082");
    expect(totpCode(RFC_SECRET_B32, 1234567890)).toBe("005924");
  });
});

describe("totp / verificação", () => {
  it("aceita o código da janela atual e o da janela vizinha (tolerância ±1)", () => {
    const now = 1111111111;
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now), now)).toBe(true);
    // Código da janela ANTERIOR (30s atrás) ainda vale com window=1…
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now - 30), now)).toBe(true);
    // …mas não com window=0.
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now - 30), now, 0)).toBe(false);
    // Duas janelas atrás é rejeitado com a tolerância padrão.
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now - 90), now)).toBe(false);
  });

  it("rejeita formatos inválidos e aceita espaços no meio do código", () => {
    const now = 59;
    expect(verifyTotp(RFC_SECRET_B32, "abc123", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "12345", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, "287 082", now)).toBe(true);
  });
});

describe("totp / anti-replay (verifyTotpConsume)", () => {
  const now = 1111111111;
  const counterNow = Math.floor(now / TOTP_STEP_SECONDS);

  it("devolve o counter que casou para códigos válidos", () => {
    expect(verifyTotpConsume(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now), now)).toBe(counterNow);
    // Código da janela anterior casa e devolve o counter anterior.
    expect(verifyTotpConsume(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now - 30), now)).toBe(
      counterNow - 1
    );
  });

  it("devolve null para código inválido", () => {
    expect(verifyTotpConsume(RFC_SECRET_B32, "000000", now)).toBeNull();
  });

  it("rejeita reuso: counter <= lastCounter volta null (anti-replay)", () => {
    // Já consumimos o counter atual: reapresentá-lo é rejeitado.
    expect(verifyTotpConsume(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now), now, counterNow)).toBeNull();
    // Um código da janela anterior (counter-1) também é rejeitado se já passamos por counterNow.
    expect(
      verifyTotpConsume(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now - 30), now, counterNow)
    ).toBeNull();
    // Mas um código NOVO (counter+1, janela seguinte) é aceito.
    expect(
      verifyTotpConsume(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, now + 30), now, counterNow)
    ).toBe(counterNow + 1);
  });
});

describe("totp / segredo e URI", () => {
  it("gera segredo base32 de 160 bits e URI otpauth compatível", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes → 32 chars base32
    const url = otpauthUrl({
      issuer: "Financeira PME",
      account: "ana@cafeaurora.com.br",
      secretBase32: secret,
    });
    expect(url).toContain("otpauth://totp/Financeira%20PME%3Aana%40cafeaurora.com.br");
    expect(url).toContain(`secret=${secret}`);
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});
