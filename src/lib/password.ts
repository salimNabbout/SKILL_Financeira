/**
 * Hash de senha com scrypt (node:crypto) — sem dependências externas.
 * Formato: scrypt$N$salt_hex$hash_hex
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N }).toString("hex");
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const [, nStr, salt, hashHex] = parts;
  const n = Number(nStr);
  if (!Number.isFinite(n) || n < 2) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: n });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
