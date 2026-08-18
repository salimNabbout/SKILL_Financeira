import { getContainer } from "@/lib/container";
import { setSessionCookie } from "@/lib/session";
import { login } from "@/app/api/_lib/handlers";
import { readJson, withErrors } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** POST /api/v1/auth/login — { email, password } → cookie de sessão + dados do usuário. */
export const POST = withErrors(async (req) => {
  const container = await getContainer();
  const result = await login(container, await readJson(req));
  await setSessionCookie(result.user.id, result.companyId);
  return json(result);
});
