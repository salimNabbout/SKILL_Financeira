/** Primitivas de UI compartilhadas — mantêm as telas visualmente consistentes. */

import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-[var(--ink-muted)]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-4 ${className}`}>
      {title ? (
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "ok" | "warn" | "crit";
}) {
  const toneClass =
    tone === "ok"
      ? "text-[var(--ok)]"
      : tone === "warn"
        ? "text-[var(--warn)]"
        : tone === "crit"
          ? "text-[var(--crit)]"
          : "";
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--ink-muted)]">{hint}</p> : null}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  ok: "bg-emerald-50 text-[var(--ok)] border-emerald-200",
  warn: "bg-amber-50 text-[var(--warn)] border-amber-200",
  crit: "bg-red-50 text-[var(--crit)] border-red-200",
  neutral: "bg-slate-100 text-slate-700 border-slate-200",
  brand: "bg-blue-50 text-[var(--brand)] border-blue-200",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-full border px-2 py-0.5 text-center text-xs font-medium ${BADGE_TONES[tone] ?? BADGE_TONES.neutral}`}
    >
      {children}
    </span>
  );
}

/** Mapeia status do domínio para o tom visual do Badge. */
export function statusTone(status: string): keyof typeof BADGE_TONES {
  if (["paid", "received", "executed", "approved", "confirmed", "auto_confirmed", "completed", "success", "resolved", "issued", "sent"].includes(status)) return "ok";
  if (["pending_approval", "awaiting_approval", "pending", "suggested", "scheduled", "warning", "partially_paid", "partially_received", "draft", "running", "open", "acknowledged"].includes(status)) return "warn";
  if (["canceled", "rejected", "failed", "error", "expired", "critical"].includes(status)) return "crit";
  return "neutral";
}

export function Table({
  headers,
  children,
  align = [],
}: {
  headers: string[];
  children: ReactNode;
  /** "r" para alinhar coluna à direita (valores). */
  align?: ("l" | "r")[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--ink-muted)]">
            {headers.map((h, i) => (
              <th key={h + i} className={`px-3 py-2 font-medium ${align[i] === "r" ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--line)]">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  right = false,
  className = "",
}: {
  children: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 align-middle ${right ? "tabular text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

export function Button({
  children,
  variant = "primary",
  type = "submit",
  name,
  value,
  formAction,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "success";
  type?: "submit" | "button";
  name?: string;
  value?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formAction?: any;
}) {
  const styles =
    variant === "primary"
      ? "bg-[var(--brand)] text-[var(--brand-ink)] hover:opacity-90"
      : variant === "danger"
        ? "bg-[var(--crit)] text-white hover:opacity-90"
        : variant === "success"
          ? "bg-[var(--ok)] text-white hover:opacity-90"
          : "border border-[var(--line)] bg-white text-[var(--ink)] hover:bg-slate-50";
  return (
    <button
      type={type}
      name={name}
      value={value}
      formAction={formAction}
      className={`inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium transition ${styles}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-[var(--ink)]">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]";

export function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-[var(--line)] p-6 text-center text-sm text-[var(--ink-muted)]">
      {message}
    </p>
  );
}
