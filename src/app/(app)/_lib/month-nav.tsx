/** Seletor de mês por links (sem JS) — usado por DRE, indicadores, orçamento e relatórios. */

import Link from "next/link";
import { addMonths, type ISOMonth } from "@/core/dates";

const MONTH_LABELS = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

export function formatMonthBR(month: ISOMonth): string {
  const [y, m] = month.split("-");
  const idx = Number(m) - 1;
  return `${MONTH_LABELS[idx] ?? m}/${y}`;
}

export function isISOMonth(value: string | undefined): value is ISOMonth {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Últimos `count` meses terminando em `latest` (inclusive), em ordem cronológica. */
export function lastMonths(latest: ISOMonth, count: number): ISOMonth[] {
  const months: ISOMonth[] = [];
  for (let i = count - 1; i >= 0; i--) {
    months.push(addMonths(`${latest}-01`, -i).slice(0, 7));
  }
  return months;
}

export function MonthNav({
  basePath,
  selected,
  latest,
  count = 8,
  param = "period",
  extraQuery = {},
}: {
  basePath: string;
  selected: ISOMonth;
  latest: ISOMonth;
  count?: number;
  param?: string;
  /** Outros filtros da tela, preservados ao trocar de mês (valores vazios saem). */
  extraQuery?: Record<string, string | undefined>;
}) {
  const href = (m: ISOMonth) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(extraQuery)) if (v) qs.set(k, v);
    qs.set(param, m);
    return `${basePath}?${qs.toString()}`;
  };
  const months = lastMonths(latest, count);
  if (!months.includes(selected)) months.unshift(selected);
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Selecionar mês">
      {months.map((m) => (
        <Link
          key={m}
          href={href(m)}
          className={
            m === selected
              ? "rounded-lg bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-ink)]"
              : "rounded-lg border border-[var(--line)] bg-white px-2.5 py-1 text-xs text-[var(--ink)] hover:bg-slate-50"
          }
        >
          {formatMonthBR(m)}
        </Link>
      ))}
    </nav>
  );
}
