"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { verifyPasswordAsync } from "@/lib/password";
import { InMemoryRateLimiter } from "@/lib/rate-limit";
import { verifyTotpConsume } from "@/lib/totp";
import { setSessionCookie, clearSessionCookie } from "@/lib/session";
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
  const user = await repos.users.findByEmail(email);
  if (!user || !user.active || !(await verifyPasswordAsync(password, user.passwordHash))) {
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
  const audit = new HashChainAuditTrail(repos.audit, clock, ids);
  await audit.record(companyId, {
    actor: { type: "user", id: user.id },
    action: "auth.login",
    entityType: "User",
    entityId: user.id,
  });

  await setSessionCookie(user.id, companyId);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
