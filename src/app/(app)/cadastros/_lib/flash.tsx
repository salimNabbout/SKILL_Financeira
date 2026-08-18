/** Banner de feedback pós-ação (?ok= / ?erro=) — padrão das páginas do grupo B. */

export function Flash({ ok, erro }: { ok?: string; erro?: string }) {
  if (!ok && !erro) return null;
  return (
    <div className="mb-4 space-y-2">
      {ok ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-[var(--ok)]">
          {ok}
        </p>
      ) : null}
      {erro ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--crit)]">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
