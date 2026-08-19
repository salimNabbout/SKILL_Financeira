/**
 * Resolução do segredo de assinatura da sessão.
 *
 * Em produção, exige SESSION_SECRET definido e diferente do valor de exemplo —
 * caso contrário o boot falha alto (nunca roda com segredo público/conhecido).
 * Fora de produção, mantém um valor de desenvolvimento para não atrapalhar
 * demo/testes/dev local.
 */

export const DEV_SESSION_SECRET = "dev-secret-change-me-0123456789abcdef";

export function resolveSessionSecret(): string {
  // String vazia conta como ausente (evita rodar com segredo "" por engano).
  const configured = process.env.SESSION_SECRET?.trim() || undefined;
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (!configured || configured === DEV_SESSION_SECRET) {
      throw new Error(
        "SESSION_SECRET ausente ou igual ao valor de exemplo em produção. " +
          "Defina um segredo forte e aleatório em SESSION_SECRET antes de iniciar."
      );
    }
    return configured;
  }

  return configured ?? DEV_SESSION_SECRET;
}
