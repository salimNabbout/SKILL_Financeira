import { Badge, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { todayInTz, type ISOMonth } from "@/core/dates";
import { getContainer } from "@/lib/container";
import { formatBRL } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { formatMonthBR, isISOMonth, MonthNav } from "../_lib/month-nav";
import { runSkillForSession } from "../_lib/run-skill";
import { isSkillError, SkillResultMeta, SkillUnavailableCard } from "../_lib/result-meta";

// Formas defensivas do contrato de controladoria_indicadores (escrita em paralelo).
interface DreStatementView {
  receitaBrutaCents?: number;
  deducoesCents?: number;
  receitaLiquidaCents?: number;
  custosCents?: number;
  lucroBrutoCents?: number;
  despesasOperacionaisCents?: number;
  ebitdaCents?: number;
  resultadoFinanceiroCents?: number;
  resultadoCents?: number;
  outrasCents?: number;
}

interface BreakdownLineView {
  dreGroup?: string;
  categoryId?: string | null;
  categoryName?: string;
  amountCents?: number;
}

interface DreDataView {
  period?: ISOMonth;
  dre?: DreStatementView;
  breakdown?: BreakdownLineView[];
  formula?: string;
  regime?: string;
}

const DRE_GROUP_LABEL: Record<string, string> = {
  receita_bruta: "Receita bruta",
  deducoes: "Deduções",
  custos: "Custos",
  despesas_operacionais: "Despesas operacionais",
  despesas_financeiras: "Despesas financeiras",
  receitas_financeiras: "Receitas financeiras",
  outras: "Outras",
};

interface DreRow {
  label: string;
  valueCents: number | undefined;
  /** Linha subtrativa exibida com sinal negativo e indentação. */
  indent?: boolean;
  subtotal?: boolean;
  muted?: boolean;
}

function buildRows(d: DreStatementView | undefined): DreRow[] {
  const neg = (v: number | undefined) => (typeof v === "number" ? -v : undefined);
  return [
    { label: "Receita bruta", valueCents: d?.receitaBrutaCents },
    { label: "(-) Deduções e impostos sobre vendas", valueCents: neg(d?.deducoesCents), indent: true },
    { label: "(=) Receita líquida", valueCents: d?.receitaLiquidaCents, subtotal: true },
    { label: "(-) Custos", valueCents: neg(d?.custosCents), indent: true },
    { label: "(=) Lucro bruto", valueCents: d?.lucroBrutoCents, subtotal: true },
    { label: "(-) Despesas operacionais", valueCents: neg(d?.despesasOperacionaisCents), indent: true },
    { label: "(=) EBITDA gerencial", valueCents: d?.ebitdaCents, subtotal: true },
    { label: "(+/-) Resultado financeiro", valueCents: d?.resultadoFinanceiroCents, indent: true },
    { label: "(=) Resultado do período", valueCents: d?.resultadoCents, subtotal: true },
    {
      label: "Outras receitas e despesas (informativo, fora do resultado)",
      valueCents: d?.outrasCents,
      indent: true,
      muted: true,
    },
  ];
}

export default async function DrePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const { clock } = await getContainer();
  const sp = await searchParams;
  const currentMonth = todayInTz(clock.now(), session.config.timezone).slice(0, 7);
  const period: ISOMonth = isISOMonth(sp.period) ? sp.period : currentMonth;

  const dreRes = await runSkillForSession<DreDataView>(session, "controladoria_indicadores", {
    action: "dre",
    period,
  });

  const rows = buildRows(dreRes.data?.dre);
  const breakdown = dreRes.data?.breakdown ?? [];

  return (
    <div>
      <PageHeader
        title="DRE gerencial"
        subtitle={`Demonstração de resultado gerencial de ${formatMonthBR(period)}`}
        actions={<Badge tone="brand">Regime de competência</Badge>}
      />

      <div className="mb-4">
        <MonthNav basePath="/dre" selected={period} latest={currentMonth} />
      </div>

      {isSkillError(dreRes) ? (
        <SkillUnavailableCard title={`DRE de ${formatMonthBR(period)}`} result={dreRes} />
      ) : (
        <>
          <Card title={`Resultado de ${formatMonthBR(period)}`}>
            <Table headers={["Linha", "Valor"]} align={["l", "r"]}>
              {rows.map((row) => (
                <tr key={row.label} className={row.subtotal ? "bg-slate-50" : ""}>
                  <Td
                    className={
                      row.subtotal
                        ? "font-semibold"
                        : row.muted
                          ? "pl-8 text-[var(--ink-muted)]"
                          : row.indent
                            ? "pl-8"
                            : ""
                    }
                  >
                    {row.label}
                  </Td>
                  <Td
                    right
                    className={`${row.subtotal ? "font-semibold" : ""} ${
                      typeof row.valueCents === "number" && row.valueCents < 0
                        ? "text-[var(--crit)]"
                        : ""
                    } ${row.muted ? "text-[var(--ink-muted)]" : ""}`}
                  >
                    {typeof row.valueCents === "number" ? formatBRL(row.valueCents) : "—"}
                  </Td>
                </tr>
              ))}
            </Table>
            {dreRes.data?.formula ? (
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                Fórmula: <code>{dreRes.data.formula}</code>
              </p>
            ) : null}
            <SkillResultMeta result={dreRes} />
          </Card>

          <div className="mt-4">
            <Card>
              <details>
                <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                  Detalhamento por categoria
                </summary>
                <div className="mt-3">
                  {breakdown.length === 0 ? (
                    <EmptyState message="Sem lançamentos classificados no período." />
                  ) : (
                    <Table headers={["Grupo DRE", "Categoria", "Valor"]} align={["l", "l", "r"]}>
                      {breakdown.map((line, i) => (
                        <tr key={`${line.dreGroup}-${line.categoryId ?? "sem"}-${i}`}>
                          <Td>{DRE_GROUP_LABEL[line.dreGroup ?? ""] ?? line.dreGroup ?? "—"}</Td>
                          <Td>{line.categoryName ?? "Sem categoria"}</Td>
                          <Td right>{formatBRL(line.amountCents ?? 0)}</Td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </div>
              </details>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
