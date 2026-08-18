/**
 * A senha temporária NUNCA vai na URL (?ok=) — iria parar em logs/histórico.
 * Ela viaja em um cookie HttpOnly de curtíssima vida (60s), lido e exibido uma vez.
 */
export const FLASH_SECRET_COOKIE = "financeira_flash_secret";
