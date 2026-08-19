import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionSecret, DEV_SESSION_SECRET } from "../session-secret";

describe("resolveSessionSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("usa o valor de desenvolvimento quando SESSION_SECRET está ausente fora de produção", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", "");
    expect(resolveSessionSecret()).toBe(DEV_SESSION_SECRET);
  });

  it("usa SESSION_SECRET quando definido", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", "um-segredo-forte-de-producao-1234567890");
    expect(resolveSessionSecret()).toBe("um-segredo-forte-de-producao-1234567890");
  });

  it("lança em produção quando SESSION_SECRET está ausente", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => resolveSessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("lança em produção quando SESSION_SECRET é igual ao valor de exemplo", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", DEV_SESSION_SECRET);
    expect(() => resolveSessionSecret()).toThrow(/SESSION_SECRET/);
  });

  it("aceita SESSION_SECRET forte em produção", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "outro-segredo-bem-longo-e-aleatorio-987654321");
    expect(resolveSessionSecret()).toBe("outro-segredo-bem-longo-e-aleatorio-987654321");
  });
});
