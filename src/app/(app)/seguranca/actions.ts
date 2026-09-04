"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hashPassword, verifyPassword } from "@/lib/password";
import { generateTotpSecret, verifyTotp } from "@/lib/totp";
import { validatePassword } from "@/core/password-policy";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/seguranca";

/** Nunca auditar material de segredo: só se havia ou não um segredo. */
function mascarar(secret: string | undefined): string {
  return secret ? "[definido]" : "[ausente]";
}

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { repos, clock, audit } = await getContainer();

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (!verifyPassword(current, session.user.passwordHash)) {
    fail("Senha atual incorreta.");
  }
  if (next !== confirm) {
    fail("A confirmação não confere com a nova senha.");
  }
  const violations = validatePassword(session.config.passwordPolicy, next);
  if (violations.length > 0) {
    fail(`Nova senha não atende à política: ${violations.join(" ")}`);
  }

  try {
    await repos.users.update({
      ...session.user,
      passwordHash: hashPassword(next),
      updatedAt: clock.now().toISOString(),
    });
    // Auditoria sem NENHUM material de senha (nem hash).
    await audit.record(session.company.id, {
      actor: session.actor,
      action: "user.password_changed",
      entityType: "user",
      entityId: session.user.id,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok("Senha alterada com sucesso.");
}

export async function startTotpSetupAction(): Promise<void> {
  const session = await requireSession();
  const { repos, clock, audit } = await getContainer();
  if (session.user.totpEnabled) {
    fail("2FA já está ativo — desative antes de gerar um novo segredo.");
  }
  try {
    // Segredo fica PENDENTE (totpEnabled=false) até a confirmação com um código.
    const atualizado = await repos.users.update({
      ...session.user,
      totpSecret: generateTotpSecret(),
      totpEnabled: false,
      updatedAt: clock.now().toISOString(),
    });
    // Gerar/substituir o segundo fator é ação sensível e passava sem rastro:
    // dava para trocar o segredo de 2FA sem deixar nenhum registro.
    // O SEGREDO nunca entra na trilha — só a marca de que existe um pendente.
    await audit.record(session.company.id, {
      actor: session.actor,
      action: "user.totp_setup_started",
      entityType: "user",
      entityId: session.user.id,
      before: { totpEnabled: session.user.totpEnabled, totpSecret: mascarar(session.user.totpSecret) },
      after: { totpEnabled: atualizado.totpEnabled, totpSecret: mascarar(atualizado.totpSecret) },
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok("Segredo 2FA gerado — cadastre no aplicativo autenticador e confirme com um código.");
}

export async function confirmTotpAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { repos, clock, audit } = await getContainer();
  const code = fdString(formData, "code") ?? "";

  const secret = session.user.totpSecret;
  if (!secret || session.user.totpEnabled) {
    fail("Nenhuma ativação de 2FA pendente — gere o segredo primeiro.");
  }
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  if (!verifyTotp(secret, code, nowSeconds)) {
    fail("Código inválido — confira o relógio do aparelho e tente novamente.");
  }

  try {
    await repos.users.update({
      ...session.user,
      totpEnabled: true,
      updatedAt: clock.now().toISOString(),
    });
    await audit.record(session.company.id, {
      actor: session.actor,
      action: "user.totp_enabled",
      entityType: "user",
      entityId: session.user.id,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok("Verificação em duas etapas ATIVADA — o login passará a exigir o código do aplicativo.");
}

export async function disableTotpAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { repos, clock, audit } = await getContainer();
  const code = fdString(formData, "code") ?? "";

  const secret = session.user.totpSecret;
  if (!secret || !session.user.totpEnabled) {
    fail("2FA não está ativo nesta conta.");
  }
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  if (!verifyTotp(secret, code, nowSeconds)) {
    fail("Código inválido — a desativação exige um código 2FA atual.");
  }

  try {
    await repos.users.update({
      ...session.user,
      totpSecret: undefined,
      totpEnabled: false,
      updatedAt: clock.now().toISOString(),
    });
    await audit.record(session.company.id, {
      actor: session.actor,
      action: "user.totp_disabled",
      entityType: "user",
      entityId: session.user.id,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok("Verificação em duas etapas desativada.");
}
