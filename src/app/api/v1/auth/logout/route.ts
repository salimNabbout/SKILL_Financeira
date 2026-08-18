import { clearSessionCookie } from "@/lib/session";
import { withErrors } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** POST /api/v1/auth/logout — limpa o cookie de sessão. */
export const POST = withErrors(async () => {
  await clearSessionCookie();
  return json({ ok: true });
});
