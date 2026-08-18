import {
  Button,
  Card,
  EmptyState,
  Field,
  inputClass,
  PageHeader,
  Table,
  Td,
} from "@/components/ui";
import { todayInTz, type ISOMonth } from "@/core/dates";
import type { CategoryKind } from "@/core/entities";
import { getContainer } from "@/lib/container";
import { formatBRL } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { formatMonthBR, isISOMonth, MonthNav } from "../_lib/month-nav";
import { runSkillForSession } from "../_lib/run-skill";
import { isSkillError, SkillResultMeta, SkillUnavailableCard } from "../_lib/result-meta";
import { upsertBudgetAction } from "./actions";

// Formas defensivas do contrato de orcamento_planejamento (escrita em paralelo).
interface VarianceLineView {
  categoryId?: string;
  categoryName?: string;
  budgetedCents?: number;
  actualCents?: number;
  varianceCents?: number;
  variancePercent?: number | null;
}

interface VarianceReportView {
  period?: ISOMonth;
  lines?: VarianceLineView[];
  totals?: { budgetedCents?: number; actualCents?: number; varianceCents?: number };
  formula?: string;
}

const PCT_FMT = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Cor da variação (realizado - orçado) segundo o tipo da categoria:
 * despesa acima do orçado = ruim (vermelho); receita abaixo do orçado = ruim.
 */
function varianceClass(kind: CategoryKind | undefined, varianceCents: number): string {
  if (varianceCents === 0) return "";
  const bad = kind === "expense" ? varianceCents > 0 : kind === "income" ? varianceCents < 0 : false;
  const good =
    kind === "expense" ? varianceCents < 0 : kind === "income" ? varianceCents > 0 : false;
  if (bad) return "text-[var(--crit)]";
  if (good) return "text-[var(--ok)]";
  return "";
}

export default async function OrcamentoPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; msg?: string; erro?: string }>;
}) {
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const sp = await searchParams;
  const currentMonth = todayInTz(clock.now(), session.config.timezone).slice(0, 7);
  const period: ISOMonth = isISOMonth(sp.period) ? sp.period : currentMonth;
  const currentYear = Number(currentMonth.slice(0, 4));

  const varianceRes = await runSkillForSession<VarianceReportView>(
    session,
    "orcamento_planejamento",
    { action: "variance_report", period }
  );

  const categories = await repos.categories.listAll(session.company.id);
  const kindById = new Map<string, CategoryKind>(categories.map((c) => [c.id, c.kind]));

  const lines = varianceRes.data?.lines ?? [];
  const totals = varianceRes.data?.totals;

  return (
    <div>
      <PageHeader
        title="Orçamento"
        subtitle={`Orçado vs. realizado de ${formatMonthBR(period)} e manutenção do orçamento anual`}
      />

      {sp.msg ? (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-[var(--ok)]">
          {sp.msg}
        </p>
      ) : null}
      {sp.erro ? (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--crit)]">
          {sp.erro}
        </p>
      ) : null}

      <div className="mb-4">
        <MonthNav basePath="/orcamento" selected={period} latest={currentMonth} />
      </div>

      {isSkillError(varianceRes) ? (
        <SkillUnavailableCard
          title={`Orçado vs. realizado — ${formatMonthBR(period)}`}
          result={varianceRes}
        />
      ) : (
        <Card title={`Orçado vs. realizado — ${formatMonthBR(period)}`}>
          {lines.length === 0 ? (
            <EmptyState message="Nenhuma linha de orçamento para o período. Cadastre o orçamento no formulário abaixo." />
          ) : (
            <Table
              headers={["Categoria", "Orçado", "Realizado", "Variação", "Variação %"]}
              align={["l", "r", "r", "r", "r"]}
            >
              {lines.map((l, i) => {
                const variance = l.varianceCents ?? 0;
                const cls = varianceClass(
                  l.categoryId ? kindById.get(l.categoryId) : undefined,
                  variance
                );
                return (
                  <tr key={`${l.categoryId ?? "sem"}-${i}`}>
                    <Td>{l.categoryName ?? l.categoryId ?? "Sem categoria"}</Td>
                    <Td right>{formatBRL(l.budgetedCents ?? 0)}</Td>
                    <Td right>{formatBRL(l.actualCents ?? 0)}</Td>
                    <Td right className={cls}>
                      {formatBRL(variance)}
                    </Td>
                    <Td right className={cls}>
                      {typeof l.variancePercent === "number"
                        ? `${PCT_FMT.format(l.variancePercent)}%`
                        : "—"}
                    </Td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-[var(--line)] bg-slate-50">
                <Td className="font-semibold">Total</Td>
                <Td right className="font-semibold">
                  {formatBRL(totals?.budgetedCents ?? 0)}
                </Td>
                <Td right className="font-semibold">
                  {formatBRL(totals?.actualCents ?? 0)}
                </Td>
                <Td right className="font-semibold">
                  {formatBRL(totals?.varianceCents ?? 0)}
                </Td>
                <Td right>{""}</Td>
              </tr>
            </Table>
          )}
          {varianceRes.data?.formula ? (
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              Fórmula: <code>{varianceRes.data.formula}</code>
            </p>
          ) : null}
          <SkillResultMeta result={varianceRes} />
        </Card>
      )}

      <div className="mt-4">
        <Card title="Criar ou atualizar orçamento anual">
          <p className="mb-3 text-sm text-[var(--ink-muted)]">
            Cole as linhas no formato <code>categoriaId;YYYY-MM;valor_em_reais</code> — uma linha
            por categoria e mês. Linhas iniciadas com <code>#</code> são ignoradas; valores aceitam
            os formatos <code>1.234,56</code>, <code>1234.56</code> e <code>R$ 2.500,00</code>;
            linhas repetidas da mesma categoria e mês são somadas. Repetir o envio do mesmo ano
            atualiza o orçamento existente (não duplica).
          </p>
          <form action={upsertBudgetAction} className="space-y-3">
            <input type="hidden" name="period" value={period} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nome do orçamento">
                <input
                  name="name"
                  type="text"
                  placeholder={`Orçamento ${currentYear}`}
                  className={inputClass}
                />
              </Field>
              <Field label="Ano">
                <input
                  name="year"
                  type="number"
                  min={2000}
                  max={2100}
                  defaultValue={currentYear}
                  required
                  className={inputClass}
                />
              </Field>
            </div>
            <Field label="Linhas do orçamento (CSV)">
              <textarea
                name="lines"
                rows={8}
                required
                className={`${inputClass} font-mono`}
                placeholder={`# formato: categoriaId;YYYY-MM;valor_em_reais\ncat_pessoal;${currentYear}-01;12500,00\ncat_marketing;${currentYear}-01;3.200,50\ncat_vendas;${currentYear}-01;45000`}
              />
            </Field>
            <Button>Salvar orçamento</Button>
          </form>
          {categories.length > 0 ? (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium text-[var(--brand)]">
                Ver categorias disponíveis ({categories.length})
              </summary>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {categories.map((c) => (
                  <li key={c.id} className="text-xs text-[var(--ink-muted)]">
                    <code>{c.id}</code> — {c.name} ({c.kind === "income" ? "receita" : "despesa"})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
