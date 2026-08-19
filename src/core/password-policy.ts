/**
 * Política de senha como DADOS configuráveis (por empresa), validada de forma
 * determinística nos pontos em que uma senha é definida: troca de senha pelo
 * usuário e geração de senha temporária no convite. Nunca no login — senha já
 * aceita não é invalidada retroativamente por mudança de política.
 */

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  /** Rejeita senhas triviais/óbvias da lista embutida (comparação sem maiúsculas). */
  forbidCommon: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  forbidCommon: true,
};

/** Senhas triviais mais comuns (pt-BR incluído) — lista curta e embutida. */
const COMMON_PASSWORDS = new Set([
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "senha123",
  "password",
  "password1",
  "qwerty123",
  "abc123456",
  "brasil123",
  "mudar123",
  "financeira",
  "admin123",
  "trocar123",
]);

/**
 * Valida a senha contra a política. Retorna a lista de violações em pt-BR —
 * vazia = senha aceita. Determinística e sem I/O.
 */
export function validatePassword(policy: PasswordPolicy, password: string): string[] {
  const violations: string[] = [];
  if (password.length < policy.minLength) {
    violations.push(`Mínimo de ${policy.minLength} caracteres (a senha tem ${password.length}).`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    violations.push("Pelo menos uma letra maiúscula.");
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    violations.push("Pelo menos uma letra minúscula.");
  }
  if (policy.requireDigit && !/[0-9]/.test(password)) {
    violations.push("Pelo menos um dígito.");
  }
  if (policy.forbidCommon && COMMON_PASSWORDS.has(password.toLowerCase())) {
    violations.push("Senha muito comum — escolha outra.");
  }
  return violations;
}
