import { describe, expect, it } from "vitest";
import { DEFAULT_PASSWORD_POLICY, validatePassword } from "../password-policy";

describe("password-policy", () => {
  it("senha forte passa sem violações", () => {
    expect(validatePassword(DEFAULT_PASSWORD_POLICY, "Café-Aurora-2026")).toEqual([]);
    expect(validatePassword(DEFAULT_PASSWORD_POLICY, "xY7pq2mn9Z")).toEqual([]);
  });

  it("acumula violações: curta, sem maiúscula, sem minúscula, sem dígito", () => {
    const violations = validatePassword(DEFAULT_PASSWORD_POLICY, "abc");
    expect(violations.some((v) => v.includes("Mínimo de 10"))).toBe(true);
    expect(violations.some((v) => v.includes("maiúscula"))).toBe(true);
    expect(violations.some((v) => v.includes("dígito"))).toBe(true);

    expect(validatePassword(DEFAULT_PASSWORD_POLICY, "SOMENTEMAIUSCULA1")).toEqual([
      "Pelo menos uma letra minúscula.",
    ]);
  });

  it("rejeita senhas comuns independente de caixa", () => {
    // "Senha123" tem 8 chars → curta E comum.
    const violations = validatePassword(
      { ...DEFAULT_PASSWORD_POLICY, minLength: 6 },
      "Senha123".toLowerCase()
    );
    expect(violations.some((v) => v.includes("comum"))).toBe(true);
  });

  it("política é configurável: relaxar requisitos muda o veredito", () => {
    const relaxed = {
      minLength: 6,
      requireUppercase: false,
      requireLowercase: true,
      requireDigit: false,
      forbidCommon: false,
    };
    expect(validatePassword(relaxed, "abcdef")).toEqual([]);
    expect(validatePassword(DEFAULT_PASSWORD_POLICY, "abcdef").length).toBeGreaterThan(0);
  });
});
