/** Paginação por links (?<param>=N) — sem JavaScript no cliente. */

import Link from "next/link";
import type { Page } from "@/core/repositories";

export const PAGE_SIZE = 50;

/** Converte o parâmetro de página (1-based na URL) em offset. */
export function pageOffset(raw: string | undefined, limit: number = PAGE_SIZE): number {
  const n = Number(raw);
  const page = Number.isInteger(n) && n >= 1 ? n : 1;
  return (page - 1) * limit;
}

export function Pager({
  page,
  basePath,
  param = "p",
  extraQuery = {},
}: {
  page: Pick<Page<unknown>, "total" | "offset" | "limit">;
  basePath: string;
  param?: string;
  extraQuery?: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(page.total / page.limit));
  const current = Math.floor(page.offset / page.limit) + 1;
  if (totalPages <= 1) return null;

  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(extraQuery)) if (v) qs.set(k, v);
    if (p > 1) qs.set(param, String(p));
    const s = qs.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const linkCls = "rounded-md border border-[var(--line)] px-2 py-1 hover:bg-slate-50";

  return (
    <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Paginação">
      <span className="text-[var(--ink-muted)]">
        Página {current} de {totalPages} · {page.total} registro(s)
      </span>
      <span className="flex gap-2">
        {current > 1 ? (
          <Link href={href(current - 1)} className={linkCls}>
            ← Anterior
          </Link>
        ) : null}
        {current < totalPages ? (
          <Link href={href(current + 1)} className={linkCls}>
            Próxima →
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
