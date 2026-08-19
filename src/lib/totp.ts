/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226) com HMAC-SHA1 — node:crypto, sem
 * dependências externas. Compatível com Google Authenticator, Authy, 1Password
 * etc. (janela de 30s, 6 dígitos, segredo em base32 RFC 4648).
 *
 * O relógio é sempre INJETADO (segundos Unix) — nunca Date.now() aqui — para
 * manter os testes determinísticos com FixedClock.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Codifica bytes em base32 (RFC 4648, sem padding). */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodifica base32 (RFC 4648; aceita minúsculas e ignora padding "="). */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Caractere base32 inválido: "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Gera um segredo TOTP novo (160 bits, recomendação da RFC 4226) em base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Código TOTP do instante dado (segundos Unix). */
export function totpCode(
  secretBase32: string,
  unixSeconds: number,
  step: number = TOTP_STEP_SECONDS,
  digits: number = TOTP_DIGITS
): string {
  const counter = Math.floor(unixSeconds / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Verifica um código aceitando ±window janelas de 30s (tolerância de relógio).
 * Comparação em tempo constante por janela.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  unixSeconds: number,
  window: number = 1
): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const given = Buffer.from(normalized);
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(totpCode(secretBase32, unixSeconds + w * TOTP_STEP_SECONDS));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

/**
 * Verificação com anti-replay: devolve o COUNTER (unixSeconds/step) que casou,
 * ou null se o código for inválido. Se `lastCounter` for informado, um counter
 * ≤ lastCounter é rejeitado (o código já foi consumido) — o chamador deve
 * persistir o counter retornado para bloquear reuso dentro da janela de validade.
 */
export function verifyTotpConsume(
  secretBase32: string,
  code: string,
  unixSeconds: number,
  lastCounter?: number,
  window: number = 1
): number | null {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const given = Buffer.from(normalized);
  for (let w = -window; w <= window; w++) {
    const t = unixSeconds + w * TOTP_STEP_SECONDS;
    const counter = Math.floor(t / TOTP_STEP_SECONDS);
    if (lastCounter !== undefined && counter <= lastCounter) continue;
    const expected = Buffer.from(totpCode(secretBase32, t));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return counter;
  }
  return null;
}

/** URI otpauth:// para apps autenticadores (entrada manual ou QR gerado pelo usuário). */
export function otpauthUrl(params: { issuer: string; account: string; secretBase32: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const issuer = encodeURIComponent(params.issuer);
  return `otpauth://totp/${label}?secret=${params.secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
