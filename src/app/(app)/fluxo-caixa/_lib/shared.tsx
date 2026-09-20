/**
 * Peças compartilhadas das telas da disciplina Fluxo de Caixa: abas, seletor
 * de ano, rótulos e formatação de pontos-base. Sem estado no cliente.
 */

import Link from "next/link";
import { Badge } from "@/components/ui";
import type { CashflowCategory, CashflowEntry } from "@/core/entities";
import { CASHFLOW_GROUP_LABEL, CASHFLOW_GROUP_ORDER } from "@/core/cashflow";
import { formatBRL } from "@/lib/format";

export const BASE = "/fluxo-caixa";

export const TABS: Array<{ href: string; label: string; key: string }> = [
  { href: BASE, label: "Dashboard", key: "dashboard" },
  { href: `${BASE}/mensal`, label: "Fluxo Mensal", key: "mensal" },
  { href: `${BASE}/previsto-realizado`, label: "Previsto × Realizado", key: "previsto-realizado" },
  { href: `${BASE}/lancamentos`, label: "Lançamentos", key: "lancamentos" },
  { href: `${BASE}/parametros`, label: "Parâmetros", key: "parametros" },
];

export function FluxoTabs({ active, ano }: { active: string; ano: number }) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1 border-b border-[var(--line)]" aria-label="Telas do Fluxo de Caixa">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={`${t.href}?ano=${ano}`}
          aria-current={t.key === active ? "page" : undefined}
          className={`-mb-px rounded-t-lg border px-3 py-1.5 text-sm ${
            t.key === active
              ? "border-[var(--line)] border-b-[var(--surface)] bg-[var(--surface)] font-medium text-[var(--brand)]"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Seletor de ano base (GET), preservando outros parâmetros informados. */
export function YearSelect({ ano, years, path, extra = {} }: { ano: number; years: number[]; path: string; extra?: Record<string, string | undefined> }) {
  const all = [...new Set([...years, ano])].sort((a, b) => a - b);
  return (
    <form method="get" action={path} className="flex items-center gap-2 text-sm">
      {Object.entries(extra).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label htmlFor="ano" className="text-[var(--ink-muted)]">
        Ano base
      </label>
      <select id="ano" name="ano" defaultValue={String(ano)} className="rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-sm">
        {all.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <button type="submit" className="rounded-lg border border-[var(--line)] px-2 py-1 text-sm hover:bg-slate-50">
        Ir
      </button>
    </form>
  );
}

/** Download da pasta "Fluxo de Caixa CETEM" (7 abas, fórmulas vivas, sem macros) do ano base. */
export function ExportLink({ ano }: { ano: number }) {
  return (
    <a
      href={`/api/v1/fluxo-caixa/exportar?ano=${ano}&formato=xlsx`}
      className="rounded-lg border border-[var(--line)] px-2 py-1 text-sm hover:bg-slate-50"
      title="Baixar a planilha Fluxo de Caixa CETEM (.xlsx) com os dados reais do ano base"
      data-testid="fc-exportar"
    >
      Exportar planilha (XLSX)
    </a>
  );
}

/** Ações padrão do cabeçalho das telas: ano base + exportação (+ importação, quando pedido). */
export function HeaderActions({
  ano,
  years,
  path,
  extra,
  importar,
}: {
  ano: number;
  years: number[];
  path: string;
  extra?: Record<string, string | undefined>;
  importar?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <YearSelect ano={ano} years={years} path={path} extra={extra} />
      <ExportLink ano={ano} />
      {importar ? (
        <Link href={`${BASE}/importar?ano=${ano}`} className="rounded-lg border border-[var(--line)] px-2 py-1 text-sm hover:bg-slate-50">
          Importar planilha
        </Link>
      ) : null}
    </div>
  );
}

/** Carimbo "calculado em" — os números são recomputados a cada carga; não há cache. */
export function ComputedAt({ iso }: { iso: string }) {
  return (
    <p className="text-xs text-[var(--ink-muted)]">
      Dados calculados em {new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} a partir dos módulos
      (títulos, pagamentos, recebimentos, conciliação e ajustes manuais).
    </p>
  );
}

export const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "1.234,56" sem o símbolo; zero vira "–" nas grades densas. */
export function cell(cents: number, zeroDash = true): string {
  if (cents === 0 && zeroDash) return "–";
  return formatBRL(cents).replace("R$", "").trim();
}

/** Pontos-base → "+15,0%". */
export function fmtBp(bp: number): string {
  const sign = bp > 0 ? "+" : "";
  return `${sign}${(bp / 100).toFixed(1).replace(".", ",")}%`;
}

/** Pontos-base → valor do campo de percentual ("15,0"). */
export function bpToField(bp: number): string {
  return (bp / 100).toFixed(1).replace(".", ",");
}

export const ORIGEM_LABEL: Record<CashflowEntry["origin"], string> = {
  conciliacao: "Conciliação",
  contas_pagar: "A Pagar",
  contas_receber: "A Receber",
  ajuste_manual: "Manual",
};

export const ORIGEM_TONE: Record<CashflowEntry["origin"], "neutral" | "ok" | "warn" | "crit"> = {
  conciliacao: "ok",
  contas_pagar: "neutral",
  contas_receber: "neutral",
  ajuste_manual: "warn",
};

export const STATUS_LABEL: Record<CashflowEntry["status"], string> = { previsto: "Previsto", realizado: "Realizado" };

/** Link para o registro original no módulo de origem (auditável em um clique). */
export function originHref(e: CashflowEntry): string | null {
  switch (e.origin) {
    case "contas_pagar":
      return `/contas-a-pagar?editar=${encodeURIComponent(e.parentId ?? e.originId)}`;
    case "contas_receber":
      return e.parentId
        ? `/contas-a-receber?recebimentos=${encodeURIComponent(e.parentId)}`
        : `/contas-a-receber?editar=${encodeURIComponent(e.originId)}`;
    case "conciliacao":
      return "/conciliacao";
    case "ajuste_manual":
      return `${BASE}/lancamentos?editar=${encodeURIComponent(e.originId)}`;
  }
}

export function OrigemBadge({ e }: { e: CashflowEntry }) {
  const href = originHref(e);
  const badge = <Badge tone={ORIGEM_TONE[e.origin]}>{ORIGEM_LABEL[e.origin]}</Badge>;
  return href ? (
    <Link href={href} title="Abrir o registro original" className="inline-block hover:opacity-80">
      {badge}
    </Link>
  ) : (
    badge
  );
}

/** Select de categoria do plano, agrupado por grupo na ordem da planilha. */
export function CategorySelect({
  name,
  categories,
  defaultValue,
  includeNeutral = false,
  onlyKind,
  className,
  required,
  id,
}: {
  name: string;
  categories: CashflowCategory[];
  defaultValue?: string;
  includeNeutral?: boolean;
  onlyKind?: "entrada" | "saida";
  className: string;
  required?: boolean;
  id?: string;
}) {
  const visible = categories.filter(
    (c) => c.active && (includeNeutral || c.kind !== "neutro") && (onlyKind === undefined || c.kind === onlyKind || c.kind === "neutro")
  );
  return (
    <select name={name} id={id} defaultValue={defaultValue ?? ""} className={className} required={required}>
      <option value="">— selecione —</option>
      {CASHFLOW_GROUP_ORDER.map((g) => {
        const items = visible.filter((c) => c.group === g).sort((a, b) => a.sortOrder - b.sortOrder);
        if (items.length === 0) return null;
        return (
          <optgroup key={g} label={CASHFLOW_GROUP_LABEL[g]}>
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
