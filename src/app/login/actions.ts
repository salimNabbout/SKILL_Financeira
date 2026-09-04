"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { verifyPasswordAsync } from "@/lib/password";
import { InMemoryRateLimiter } from "@/lib/rate-limit";
import { verifyTotpConsume } from "@/lib/totp";
import { setSessionCookie, clearSessionCookie, getSession } from "@/lib/session";
import { HashChainAuditTrail } from "@/core/audit";

// Limitador por processo: 10 tentativas por IP+e-mail a cada 5 minutos.
const loginRateLimiter = new InMemoryRateLimiter({ maxAttempts: 10, windowMs: 5 * 60_000 });

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const totp = String(formData.get("totp") ?? "").trim();

  const headerStore = await headers();
  const clientKey =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerStore.get("x-real-ip") ||
    "unknown";
  const rateKey = `${clientKey}:${email.toLowerCase()}`;
  if (!loginRateLimiter.check(rateKey).allowed) {
    redirect(
      `/login?erro=${encodeURIComponent("Muitas tentativas de login. Aguarde alguns minutos e tente novamente.")}`
    );
  }

  const { repos, clock, ids } = await getContainer();
  const audit = new HashChainAuditTrail(repos.audit, clock, ids);

  /**
   * Registra uma falha de login na trilha da 1ª empresa do usuário — só quando
   * o e-mail corresponde a um usuário real com vínculo (a cadeia de auditoria é
   * por empresa; e-mail inexistente não tem empresa, fica só no rate-limiter).
   * NUNCA registra a senha digitada — apenas o e-mail tentado e o motivo.
   */
  async function recordLoginFailure(u: { id: string } | null, reason: string): Promise<void> {
    if (!u) return;
    const ms = await repos.memberships.listByUser(u.id);
    if (ms.length === 0) return;
    try {
      await audit.record(ms[0].companyId, {
        actor: { type: "user", id: u.id },
        action: "auth.login_failed",
        entityType: "user",
        entityId: u.id,
        after: { email, reason }, // sem senha — só o identificador tentado e o motivo
      });
    } catch {
      // auditoria não deve impedir a resposta de falha ao usuário
    }
  }

  const user = await repos.users.findByEmail(email);
  if (!user || !user.active || !(await verifyPasswordAsync(password, user.passwordHash))) {
    await recordLoginFailure(user, !user ? "email_desconhecido" : !user.active ? "usuario_inativo" : "senha_invalida");
    redirect(`/login?erro=${encodeURIComponent("E-mail ou senha inválidos.")}`);
  }

  // 2FA: com TOTP ativo, o código é obrigatório, validado contra o relógio
  // injetado (tolerância de ±1 janela de 30s) e com anti-replay por counter.
  if (user.totpEnabled && user.totpSecret) {
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    const matchedCounter = totp
      ? verifyTotpConsume(user.totpSecret, totp, nowSeconds, user.totpLastCounter)
      : null;
    if (matchedCounter === null) {
      await recordLoginFailure(user, "totp_invalido");
      redirect(
        `/login?erro=${encodeURIComponent("Código 2FA ausente, inválido ou já utilizado (sua conta exige verificação em duas etapas).")}`
      );
    }
    await repos.users.update({ ...user, totpLastCounter: matchedCounter });
  }

  const memberships = await repos.memberships.listByUser(user.id);
  if (memberships.length === 0) {
    redirect(`/login?erro=${encodeURIComponent("Usuário sem empresa vinculada.")}`);
  }

  // Autenticação concluída: zera o contador para não punir o usuário legítimo.
  loginRateLimiter.reset(rateKey);
  const companyId = memberships[0].companyId;
  await audit.record(companyId, {
    actor: { type: "user", id: user.id },
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
  });

  await setSessionCookie(user.id, companyId);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  // Registra o encerramento na trilha ANTES de limpar a sessão (para ter o
  // ator e a empresa). Falha na auditoria não deve impedir o logout.
  const session = await getSession();
  if (session) {
    try {
      const { repos, clock, ids } = await getContainer();
      const audit = new HashChainAuditTrail(repos.audit, clock, ids);
      await audit.record(session.company.id, {
        actor: session.actor,
        action: "auth.logout",
        entityType: "user",
        entityId: session.user.id,
      });
    } catch {
      // ignora: o logout precisa ocorrer mesmo se a auditoria falhar
    }
  }
  await clearSessionCookie();
  redirect("/login");
}
