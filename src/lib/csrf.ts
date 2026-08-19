/**
 * Defesa CSRF para as rotas /api/v1: com cookie de sessão SameSite=Lax, uma
 * requisição POST cross-site top-level ainda envia o cookie. Aqui rejeitamos
 * mutações cuja origem (Origin / Sec-Fetch-Site) indique outro site.
 *
 * Server actions do Next 15 já têm defesa nativa por Origin; este módulo cobre
 * as rotas de API REST, que não têm essa proteção embutida.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROTECTED_PREFIX = "/api/v1";

/**
 * true quando a requisição é uma MUTAÇÃO em /api/v1 vinda de outro site.
 * Sem Origin nem Sec-Fetch-Site (clientes não-navegador, mesma origem) NÃO é
 * bloqueada — o alvo do CSRF é o navegador do usuário autenticado.
 */
export function isForbiddenCrossSiteMutation(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;

  const url = new URL(req.url);
  if (!url.pathname.startsWith(PROTECTED_PREFIX)) return false;

  // Sinal explícito do navegador: Sec-Fetch-Site cross-site/cross-origin.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return true;

  // Origin presente e diferente do host da requisição ⇒ cross-site.
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host !== url.host;
    } catch {
      return true; // Origin malformado: trata como suspeito.
    }
  }

  return false;
}
