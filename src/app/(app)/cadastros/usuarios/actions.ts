"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { inviteUser, setUserActive, updateMembership, type UserAdminDeps } from "@/lib/user-admin";
import {
  errorMessage,
  fdOptional,
  fdString,
  parseBRLToCents,
} from "@/app/(app)/cadastros/_lib/form-utils";

import { FLASH_SECRET_COOKIE } from "./flash";

const PATH = "/cadastros/usuarios";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

async function buildDeps(): Promise<UserAdminDeps> {
  const { repos, clock, ids, audit } = await getContainer();
  return { repos, clock, ids, audit };
}

/** "" → null (ilimitado dentro do papel); senão valor em reais → centavos. */
function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  return parseBRLToCents(raw);
}

export async function inviteUserAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const deps = await buildDeps();

  let temporaryPassword: string | undefined;
  let email = "";
  let existingUser = false;
  try {
    const result = await inviteUser(deps, {
      companyId: session.company.id,
      actor: session.actor,
      name: fdString(formData, "name"),
      email: fdString(formData, "email"),
      role: fdString(formData, "role"),
      approvalLimitCents: parseLimit(fdOptional(formData, "approvalLimit")),
    });
    temporaryPassword = result.temporaryPassword;
    email = result.user.email;
    existingUser = result.existingUser;
  } catch (error) {
    fail(errorMessage(error));
  }

  if (temporaryPassword) {
    const store = await cookies();
    // Escopado por empresa: trocar de empresa não pode exibir o segredo alheio.
    store.set(
      FLASH_SECRET_COOKIE,
      JSON.stringify({
        companyId: session.company.id,
        message: `Senha temporária de ${email}: ${temporaryPassword}`,
      }),
      { httpOnly: true, sameSite: "lax", path: PATH, maxAge: 60 }
    );
    ok(
      "Usuário criado e vinculado (convite MOCK — nenhum e-mail foi enviado). A senha temporária aparece abaixo UMA única vez."
    );
  }
  ok(
    existingUser
      ? `Usuário ${email} já existia e foi vinculado à empresa (a senha atual permanece).`
      : "Usuário vinculado à empresa."
  );
}

export async function updateMembershipAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const deps = await buildDeps();

  try {
    await updateMembership(deps, {
      companyId: session.company.id,
      actor: session.actor,
      userId: fdString(formData, "userId"),
      role: fdString(formData, "role"),
      approvalLimitCents: parseLimit(fdOptional(formData, "approvalLimit")),
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok("Papel e alçada atualizados.");
}

export async function toggleUserActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const deps = await buildDeps();

  try {
    await setUserActive(deps, {
      companyId: session.company.id,
      actor: session.actor,
      userId: fdString(formData, "userId"),
      active: fdString(formData, "active") === "1",
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok("Situação do usuário atualizada.");
}
