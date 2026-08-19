import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isForbiddenCrossSiteMutation } from "@/lib/csrf";

/**
 * Middleware de borda: rejeita mutações cross-site nas rotas /api/v1 (defesa
 * CSRF; o cookie de sessão é SameSite=Lax). Só age nessas rotas — ver `matcher`.
 */
export function middleware(req: NextRequest): NextResponse {
  if (isForbiddenCrossSiteMutation(req)) {
    return NextResponse.json(
      { error: "forbidden_cross_site", message: "Requisição cross-site bloqueada (CSRF)." },
      { status: 403 }
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/v1/:path*"],
};
