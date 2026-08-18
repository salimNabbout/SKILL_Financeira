/**
 * Renderização padronizada do envelope SkillResult nas páginas:
 * alertas, pendências, suposições e fontes de dados (transparência ao usuário),
 * além do cartão defensivo "Skill em implementação" para resultados com erro.
 */

import { Badge, Card } from "@/components/ui";
import type { AlertSeverity, SkillResult } from "@/core/types";

/** true quando o resultado não pode alimentar a página (erro ou sem dados). */
export function isSkillError(
  result: SkillResult<unknown> | null | undefined
): boolean {
  return !result || result.status === "error" || result.data == null;
}

/** Cartão exibido quando a skill ainda é stub ou falhou — a página nunca quebra. */
export function SkillUnavailableCard({
  title,
  result,
}: {
  title: string;
  result?: SkillResult<unknown> | null;
}) {
  const detail = result?.alerts?.[0]?.message;
  return (
    <Card title={title}>
      <p className="text-sm text-[var(--ink-muted)]">Skill em implementação.</p>
      {detail ? <p className="mt-1 text-xs text-[var(--ink-muted)]">{detail}</p> : null}
    </Card>
  );
}

const SEVERITY_TONE: Record<AlertSeverity, "brand" | "warn" | "crit"> = {
  info: "brand",
  warning: "warn",
  critical: "crit",
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Atenção",
  critical: "Crítico",
};

/**
 * Bloco compacto com alertas, pendências, suposições e fontes de um SkillResult.
 * Renderiza nada quando não há o que mostrar.
 */
export function SkillResultMeta({
  result,
  showSources = true,
}: {
  result: SkillResult<unknown> | null | undefined;
  showSources?: boolean;
}) {
  if (!result) return null;
  const alerts = result.alerts ?? [];
  const pending = result.pending_items ?? [];
  const assumptions = result.assumptions ?? [];
  const sources = showSources ? (result.audit?.data_sources ?? []) : [];
  const confidence =
    typeof result.confidence === "number" && result.confidence < 1
      ? result.confidence
      : null;

  if (
    alerts.length === 0 &&
    pending.length === 0 &&
    assumptions.length === 0 &&
    sources.length === 0 &&
    confidence === null
  ) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2 border-t border-[var(--line)] pt-3 text-xs">
      {alerts.length > 0 ? (
        <ul className="space-y-1">
          {alerts.map((a, i) => (
            <li key={`${a.code}-${i}`} className="flex items-start gap-2">
              <Badge tone={SEVERITY_TONE[a.severity] ?? "neutral"}>
                {SEVERITY_LABEL[a.severity] ?? a.severity}
              </Badge>
              <span className="text-[var(--ink)]">{a.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {pending.length > 0 ? (
        <ul className="space-y-1">
          {pending.map((p, i) => (
            <li key={`${p.code}-${i}`} className="text-[var(--ink)]">
              <span className="font-medium">Pendência:</span> {p.description}
              {p.suggestedAction ? (
                <span className="text-[var(--ink-muted)]"> — {p.suggestedAction}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {assumptions.length > 0 ? (
        <div className="text-[var(--ink-muted)]">
          <span className="font-medium text-[var(--ink)]">Suposições:</span>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {confidence !== null ? (
        <p className="text-[var(--ink-muted)]">
          Confiança do cálculo: {(confidence * 100).toFixed(0)}% (estimativa/heurística).
        </p>
      ) : null}
      {sources.length > 0 ? (
        <p className="text-[var(--ink-muted)]">Fontes: {sources.join(", ")}</p>
      ) : null}
    </div>
  );
}

/** Converte listas vindas de skills (defensivo) em string[] renderizável. */
export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const text = o.message ?? o.description ?? o.label ?? o.text;
        if (typeof text === "string") return text;
      }
      return null;
    })
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}
