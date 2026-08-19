"use server";

import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { verifyPassword } from "@/lib/password";
import { verifyTotp } from "@/lib/totp";
import { setSessionCookie, clearSessionCookie } from "@/lib/session";
import { HashChainAuditTrail } from "@/core/audit";

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const totp = String(formData.get("totp") ?? "").trim();

  const { repos, clock, ids } = await getContainer();
  const user = await repos.users.findByEmail(email);
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    redirect(`/login?erro=${encodeURIComponent("E-mail ou senha inválidos.")}`);
  }

  // 2FA: com TOTP ativo, o código é obrigatório e validado contra o relógio
  // injetado (tolerância de ±1 janela de 30s).
  if (user.totpEnabled && user.totpSecret) {
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    if (!totp || !verifyTotp(user.totpSecret, totp, nowSeconds)) {
      redirect(
        `/login?erro=${encodeURIComponent("Código 2FA ausente ou inválido (sua conta exige verificação em duas etapas).")}`
      );
    }
  }

  const memberships = await repos.memberships.listByUser(user.id);
  if (memberships.length === 0) {
    redirect(`/login?erro=${encodeURIComponent("Usuário sem empresa vinculada.")}`);
  }

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
