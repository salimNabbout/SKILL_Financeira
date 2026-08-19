import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync } from "../password";

describe("password assíncrono (não bloqueia o event loop)", () => {
  it("hashPasswordAsync gera hash verificável pela versão síncrona e vice-versa", async () => {
    const senha = "SenhaForte123";
    const hashAsync = await hashPasswordAsync(senha);
    // Formato compatível: a versão síncrona verifica o hash gerado pela async.
    expect(verifyPassword(senha, hashAsync)).toBe(true);
    expect(verifyPassword("errada", hashAsync)).toBe(false);

    // E a async verifica o hash gerado pela síncrona.
    const hashSync = hashPassword(senha);
    expect(await verifyPasswordAsync(senha, hashSync)).toBe(true);
    expect(await verifyPasswordAsync("errada", hashSync)).toBe(false);
  });

  it("verifyPasswordAsync rejeita formato inválido sem lançar", async () => {
    expect(await verifyPasswordAsync("x", "formato-invalido")).toBe(false);
    expect(await verifyPasswordAsync("x", "scrypt$1$salt$hash")).toBe(false); // N < 2
  });
});
