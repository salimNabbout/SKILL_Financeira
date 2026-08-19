/**
 * Hash de senha com scrypt (node:crypto) — sem dependências externas.
 * Formato: scrypt$N$salt_hex$hash_hex
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const SCRYPT_N = 16384;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number }
) => Promise<Buffer>;

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

/**
 * Versão assíncrona (scrypt em thread do libuv): NÃO bloqueia o event loop.
 * Produz o MESMO formato serializado das versões síncronas — os hashes são
 * intercambiáveis. Preferir estas nos caminhos de request (login, troca de senha).
 */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64, { N: SCRYPT_N })).toString("hex");
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const [, nStr, salt, hashHex] = parts;
  const n = Number(nStr);
  if (!Number.isFinite(n) || n < 2) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, salt, expected.length, { N: n });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
