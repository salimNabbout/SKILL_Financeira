"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { formatBR, formatBRL } from "@/lib/format";
import { SKIP_REASON_LABEL } from "@/core/cashflow/import";
import type { CashflowImportReport } from "@/app/api/_lib/cashflow";
import { analisarPlanilhaAction, confirmarImportacaoAction, type AnaliseState } from "../actions";

const PREVIEW_LIMIT = 300;
const inputCls = "w-full rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]";
const btnCls = "rounded-lg bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const thCls = "px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]";
const tdCls = "px-2 py-1 align-top";

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={btnCls} disabled={pending}>
      {pending ? busy : idle}
    </button>
  );
}

function Resumo({ report }: { report: CashflowImportReport }) {
  const items: Array<[string, number, string]> = [
    ["Linhas lidas", report.linhasLidas, ""],
    ["Novas (serão importadas)", report.validas.length, "text-[var(--ok)]"],
    ["Com erro", report.erros.length, "text-[var(--crit)]"],
    ["Ignoradas (já existem)", report.ignoradas.length, ""],
  ];
  return (
    <div className="grid gap-3 md:grid-cols-4" data-testid="fc-import-resumo">
      {items.map(([label, n, cls]) => (
        <div key={label}>
          <p className="text-xs text-[var(--ink-muted)]">{label}</p>
          <p className={`text-2xl font-semibold ${cls}`}>{n}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Importar planilha: escolher o arquivo → analisar (relatório linha a linha,
 * nada gravado) → confirmar (tudo-ou-nada). O relatório fica no estado do
 * formulário, e as linhas validadas voltam ao servidor no campo oculto da
 * confirmação — o servidor não guarda nada entre as etapas.
 */
export function ImportForm({ ano, podeImportar }: { ano: number; podeImportar: boolean }) {
  const [state, analisar] = useActionState<AnaliseState, FormData>(analisarPlanilhaAction, {});
  const report = state.report;
  const rejeitado = report ? report.erros.length > 0 : false;
  const payload = report
    ? btoa(unescape(encodeURIComponent(JSON.stringify({ fileName: report.arquivo, rows: report.validas }))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
    : "";

  return (
    <div className="space-y-4">
      <form action={analisar} className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4" data-testid="fc-import-form">
        <p className="mb-2 text-sm font-medium">1 — Escolha a planilha (.xlsx)</p>
        <p className="mb-3 text-xs text-[var(--ink-muted)]">
          Só a aba <strong>Lançamentos</strong> é lida. Linhas com origem do app (Contas a pagar, Contas a receber, Conciliação bancária) e
          ajustes manuais já existentes são ignoradas; só linhas novas (Origem em branco) viram ajustes manuais. Qualquer erro rejeita o arquivo inteiro.
        </p>
        <input type="file" name="arquivo" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required className={inputCls} disabled={!podeImportar} />
        <div className="mt-3">
          <SubmitButton idle="Analisar planilha" busy="Analisando…" />
        </div>
        {state.erro ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {state.erro}
          </p>
        ) : null}
      </form>

      {report ? (
        <div className="space-y-4" data-testid="fc-import-relatorio">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
            <p className="mb-3 text-sm font-medium">
              2 — Conferência de <span className="font-mono text-xs">{report.arquivo}</span> (aba {report.aba})
            </p>
            <Resumo report={report} />
            {rejeitado ? (
              <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                Arquivo rejeitado: corrija as linhas com erro na planilha e envie de novo. Nada foi gravado.
              </p>
            ) : report.validas.length === 0 ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Nenhuma linha nova para importar: tudo o que está na planilha já existe no app.
              </p>
            ) : (
              <form action={confirmarImportacaoAction} className="mt-4 flex flex-wrap items-center gap-3">
                <input type="hidden" name="payload" value={payload} />
                <input type="hidden" name="ano" value={ano} />
                <SubmitButton idle={`Confirmar importação (${report.validas.length} linha(s))`} busy="Gravando…" />
                <span className="text-xs text-[var(--ink-muted)]">
                  Cria {report.validas.length} ajuste(s) manual(is) com a observação “importação planilha {report.arquivo}”. Entradas {formatBRL(report.totais.entradasCents)} · Saídas {formatBRL(report.totais.saidasCents)}.
                </span>
              </form>
            )}
            {report.avisos.length > 0 ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-800">
                {report.avisos.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {report.erros.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
              <p className="mb-2 text-sm font-medium text-[var(--crit)]">Linhas com erro ({report.erros.length})</p>
              <table className="w-full text-sm" data-testid="fc-import-erros">
                <thead>
                  <tr>
                    <th className={thCls}>Linha</th>
                    <th className={thCls}>Motivo</th>
                    <th className={thCls}>Conteúdo</th>
                  </tr>
                </thead>
                <tbody>
                  {report.erros.slice(0, PREVIEW_LIMIT).map((e) => (
                    <tr key={e.linha} className="border-t border-[var(--line)]">
                      <td className={tdCls}>{e.linha}</td>
                      <td className={`${tdCls} text-[var(--crit)]`}>{e.motivo}</td>
                      <td className={`${tdCls} text-xs text-[var(--ink-muted)]`}>{e.conteudo.filter(Boolean).join(" ; ").slice(0, 140)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {report.validas.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
              <p className="mb-2 text-sm font-medium">Linhas novas ({report.validas.length}{report.validas.length > PREVIEW_LIMIT ? `, mostrando ${PREVIEW_LIMIT}` : ""})</p>
              <table className="w-full text-sm" data-testid="fc-import-validas">
                <thead>
                  <tr>
                    <th className={thCls}>Linha</th>
                    <th className={thCls}>Data</th>
                    <th className={thCls}>Tipo</th>
                    <th className={thCls}>Categoria</th>
                    <th className={thCls}>Descrição</th>
                    <th className={thCls}>Centro</th>
                    <th className={thCls}>Status</th>
                    <th className={`${thCls} text-right`}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {report.validas.slice(0, PREVIEW_LIMIT).map((l) => (
                    <tr key={l.linha} className="border-t border-[var(--line)]">
                      <td className={tdCls}>{l.linha}</td>
                      <td className={tdCls}>{formatBR(l.competenceDate)}</td>
                      <td className={tdCls}>{l.kind === "entrada" ? "Entrada" : "Saída"}</td>
                      <td className={tdCls}>{l.categoryName}</td>
                      <td className={tdCls}>{l.description}</td>
                      <td className={tdCls}>{l.costCenterName ?? "—"}</td>
                      <td className={tdCls}>{l.status === "realizado" ? "Realizado" : "Previsto"}</td>
                      <td className={`${tdCls} text-right tabular-nums`}>{formatBRL(l.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {report.ignoradas.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
              <p className="mb-2 text-sm font-medium">Linhas ignoradas ({report.ignoradas.length}{report.ignoradas.length > PREVIEW_LIMIT ? `, mostrando ${PREVIEW_LIMIT}` : ""})</p>
              <table className="w-full text-sm" data-testid="fc-import-ignoradas">
                <thead>
                  <tr>
                    <th className={thCls}>Linha</th>
                    <th className={thCls}>Motivo</th>
                    <th className={thCls}>Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {report.ignoradas.slice(0, PREVIEW_LIMIT).map((s) => (
                    <tr key={s.linha} className="border-t border-[var(--line)]">
                      <td className={tdCls}>{s.linha}</td>
                      <td className={tdCls}>{SKIP_REASON_LABEL[s.motivo]}</td>
                      <td className={`${tdCls} text-xs text-[var(--ink-muted)]`}>{s.detalhe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
