import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL, formatDateTime, statusLabel } from "@/lib/format";
import type { ISODate } from "@/core/dates";
import type { ReconciliationMatch } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { confirmMatchAction, importStatementAction, rejectMatchAction, syncBankAction } from "./actions";

interface TargetInfo {
  label: string;
  description: string;
  amountCents: number;
  date: ISODate;
}

export default async function ConciliacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string; pt?: string; payable?: string }>;
}) {
  const { ok, erro, pt, payable } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const [bankAccounts, suggested, decided, unreconciledPage, payables, receivables, payments, suppliers, customers, users] =
    await Promise.all([
      repos.bankAccounts.listAll(companyId),
      repos.reconciliations.listByStatus(companyId, ["suggested"]),
      repos.reconciliations.listByStatus(companyId, ["confirmed", "auto_confirmed"]),
      // Tabela de não conciliadas paginada (data desc) — volumetria.
      repos.bankTransactions.listPage(companyId, {
        offset: pageOffset(pt),
        limit: PAGE_SIZE,
        reconciled: false,
      }),
      repos.payables.listAll(companyId),
      repos.receivables.listAll(companyId),
      repos.payments.listAll(companyId),
      repos.suppliers.listAll(companyId),
      repos.customers.listAll(companyId),
      repos.users.listAll(),
    ]);

  const accountName = new Map(bankAccounts.map((b) => [b.id, b.name]));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const payableById = new Map(payables.map((p) => [p.id, p]));
  const receivableById = new Map(receivables.map((r) => [r.id, r]));
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  const txById = new Map(
    (await Promise.all(
      [...new Set([...suggested, ...decided].map((m) => m.bankTransactionId))].map((id) =>
        repos.bankTransactions.getById(companyId, id)
      )
    ))
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => [t.id, t])
  );

  function resolveTarget(match: ReconciliationMatch): TargetInfo | null {
    if (!match.targetId) return null;
    if (match.targetType === "payable") {
      const p = payableById.get(match.targetId);
      if (!p) return null;
      return {
        label: "Título a pagar",
        description: `${supplierName.get(p.supplierId) ?? p.supplierId} — ${p.description}`,
        amountCents: p.amountCents - p.paidCents,
        date: p.dueDate,
      };
    }
    if (match.targetType === "receivable") {
      const r = receivableById.get(match.targetId);
      if (!r) return null;
      return {
        label: "Título a receber",
        description: `${customerName.get(r.customerId) ?? r.customerId} — ${r.description}`,
        amountCents: r.amountCents - r.receivedCents,
        date: r.dueDate,
      };
    }
    if (match.targetType === "payment") {
      const pmt = paymentById.get(match.targetId);
      if (!pmt) return null;
      const payable = payableById.get(pmt.payableId);
      return {
        label: "Pagamento executado",
        description: payable ? `${payable.description}` : `Pagamento ${pmt.id}`,
        amountCents: pmt.amountCents,
        date: pmt.scheduledDate,
      };
    }
    if (match.targetType === "transfer") {
      const other = txById.get(match.targetId);
      if (!other) return null;
      return {
        label: "Transferência entre contas",
        description: `${accountName.get(other.bankAccountId) ?? other.bankAccountId} — ${other.description}`,
        amountCents: other.amountCents,
        date: other.date,
      };
    }
    return null;
  }

  // Título vindo de "Conciliar" em Contas a Pagar: destaca qual conciliar.
  const focusedPayable = payable ? payableById.get(payable) : undefined;

  const recentDecided = [...decided]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 15);
  const unreconciledRows = [...unreconciledPage.items].sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)
  );

  return (
    <div>
      <PageHeader
        title="Conciliação bancária"
        subtitle="Importação de extratos (OFX/CSV), conciliação automática com grau de confiança e revisão humana das sugestões."
      />
      <Flash ok={ok} erro={erro} />

      {focusedPayable ? (
        <div className="mb-6 rounded-lg border border-[var(--brand)] bg-[var(--brand)]/5 px-4 py-3">
          <p className="text-sm font-medium">
            Conciliando o título:{" "}
            <strong>
              {supplierName.get(focusedPayable.supplierId) ?? focusedPayable.supplierId} —{" "}
              {focusedPayable.description}
            </strong>
          </p>
          <p className="mt-1 text-sm">
            {formatBRL(focusedPayable.amountCents - focusedPayable.paidCents)} em aberto, vence{" "}
            {formatBR(focusedPayable.dueDate)}. Importe o extrato ou sincronize o banco abaixo e
            confirme a sugestão de conciliação correspondente a este título.
          </p>
        </div>
      ) : payable ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Título {payable} não encontrado (pode já ter sido conciliado ou removido).
        </div>
      ) : null}

      <Card className="mb-6" title="1 — Importar extrato">
        <form action={importStatementAction} className="grid gap-4 md:grid-cols-3">
          <Field label="Conta bancária">
            <select name="bankAccountId" required className={inputClass}>
              <option value="">Selecione…</option>
              {bankAccounts
                .filter((b) => b.active)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.accountNumberMasked})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Formato">
            <select name="format" className={inputClass} defaultValue="auto">
              <option value="auto">Detectar automaticamente</option>
              <option value="ofx">OFX</option>
              <option value="csv">CSV</option>
              <option value="cnab240">CNAB240 (retorno)</option>
            </select>
          </Field>
          <div className="flex items-end">
            <Button>Importar e conciliar</Button>
          </div>
          <div className="md:col-span-2">
            <Field label="Arquivo do extrato (OFX, CSV ou CNAB240)">
              <input
                type="file"
                name="arquivo"
                accept=".ofx,.csv,.txt,.ret,.rem"
                className={`${inputClass} file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-xs file:font-medium`}
              />
            </Field>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              Até 2 MB. Codificação detectada automaticamente (UTF-8 ou ISO-8859-1 dos bancos).
            </p>
          </div>
          <div className="md:col-span-3">
            <Field label="Ou cole o conteúdo do arquivo (alternativa ao upload)">
              <textarea
                name="content"
                rows={4}
                className={`${inputClass} font-mono text-xs`}
                placeholder="Alternativa: cole aqui o conteúdo do arquivo OFX ou CSV…"
              />
            </Field>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              O arquivo enviado tem precedência sobre o texto colado. Reimportar o mesmo arquivo é
              idempotente: transações já existentes não são duplicadas.
            </p>
          </div>
        </form>
      </Card>

      <Card className="mb-6" title="1b — Sincronizar com o banco (mock)">
        <form action={syncBankAction} className="grid gap-4 md:grid-cols-3">
          <Field label="Conta bancária">
            <select name="bankAccountId" required className={inputClass}>
              <option value="">Selecione…</option>
              {bankAccounts
                .filter((b) => b.active)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.accountNumberMasked})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Período (dias para trás)">
            <input
              type="number"
              name="sinceDays"
              min={1}
              max={90}
              defaultValue={30}
              className={inputClass}
            />
          </Field>
          <div className="flex items-end">
            <Button>Sincronizar e conciliar</Button>
          </div>
          <p className="md:col-span-3 text-xs text-[var(--ink-muted)]">
            Busca transações via provedor de dados bancários configurado (porta de integração). No
            MVP o provedor é <strong>mock</strong>: gera um extrato sintético determinístico —
            nenhum banco real é consultado. Sincronizar de novo o mesmo período não duplica
            transações.
          </p>
        </form>
      </Card>

      <Card className="mb-6" title={`2 — Sugestões pendentes de revisão (${suggested.length})`}>
        {suggested.length === 0 ? (
          <EmptyState message="Nenhuma sugestão de conciliação aguardando revisão." />
        ) : (
          <div className="space-y-3">
            {suggested.map((m) => {
              const tx = txById.get(m.bankTransactionId);
              const target = resolveTarget(m);
              return (
                <div key={m.id} className="rounded-lg border border-[var(--line)] p-3">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                        Transação bancária
                      </p>
                      {tx ? (
                        <>
                          <p className="text-sm">{tx.description}</p>
                          <p className="tabular text-sm font-medium">
                            {formatBRL(tx.amountCents)} em {formatBR(tx.date)} —{" "}
                            {accountName.get(tx.bankAccountId) ?? tx.bankAccountId}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-[var(--ink-muted)]">Transação {m.bankTransactionId}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                        Alvo sugerido
                      </p>
                      {target ? (
                        <>
                          <p className="text-sm">
                            <Badge tone="brand">{target.label}</Badge> {target.description}
                          </p>
                          <p className="tabular text-sm font-medium">
                            {formatBRL(target.amountCents)} — {formatBR(target.date)}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-[var(--ink-muted)]">
                          {m.targetType} {m.targetId ?? "?"}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        Confiança: <strong>{Math.round(m.confidence * 100)}%</strong>
                        {m.notes ? ` — ${m.notes}` : ""}
                      </p>
                      {typeof m.amountCents === "number" && tx && m.amountCents < Math.abs(tx.amountCents) ? (
                        <p className="mt-1 text-xs text-[var(--ink-muted)]">
                          Porção aplicada a este alvo: <strong>{formatBRL(m.amountCents)}</strong>
                        </p>
                      ) : null}
                      {m.groupId ? (
                        <p className="mt-1 text-xs text-amber-700">
                          Decisão em grupo (rateio/transferência): confirmar ou rejeitar aplica todas
                          as partes de uma vez.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={confirmMatchAction}>
                        <input type="hidden" name="matchId" value={m.id} />
                        <Button>Confirmar</Button>
                      </form>
                      <form action={rejectMatchAction} className="flex items-center gap-2">
                        <input type="hidden" name="matchId" value={m.id} />
                        <input
                          name="notes"
                          className={`${inputClass} w-40`}
                          placeholder="Motivo (opcional)"
                        />
                        <Button variant="danger">Rejeitar</Button>
                      </form>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="mb-6" title={`3 — Transações não conciliadas (${unreconciledPage.total})`}>
        {unreconciledRows.length === 0 ? (
          <EmptyState message="Todas as transações importadas estão conciliadas." />
        ) : (
          <Table headers={["Data", "Conta", "Descrição", "Valor", "Origem"]} align={["l", "l", "l", "r", "l"]}>
            {unreconciledRows.map((t) => (
              <tr key={t.id}>
                <Td>{formatBR(t.date)}</Td>
                <Td>{accountName.get(t.bankAccountId) ?? t.bankAccountId}</Td>
                <Td>{t.description}</Td>
                <Td right>
                  <span className={t.amountCents < 0 ? "text-[var(--crit)]" : "text-[var(--ok)]"}>
                    {formatBRL(t.amountCents)}
                  </span>
                </Td>
                <Td>
                  <span className="text-xs uppercase text-[var(--ink-muted)]">{t.source}</span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <Pager page={unreconciledPage} basePath="/conciliacao" param="pt" />
      </Card>

      <Card title="4 — Histórico recente de conciliações">
        {recentDecided.length === 0 ? (
          <EmptyState message="Nenhuma conciliação confirmada ainda." />
        ) : (
          <Table
            headers={["Quando", "Transação", "Alvo", "Confiança", "Status", "Por"]}
            align={["l", "l", "l", "r", "l", "l"]}
          >
            {recentDecided.map((m) => {
              const tx = txById.get(m.bankTransactionId);
              const target = resolveTarget(m);
              return (
                <tr key={m.id}>
                  <Td>{formatDateTime(m.updatedAt)}</Td>
                  <Td>
                    {tx ? `${tx.description} (${formatBRL(tx.amountCents)} em ${formatBR(tx.date)})` : m.bankTransactionId}
                  </Td>
                  <Td>{target ? `${target.label}: ${target.description}` : `${m.targetType} ${m.targetId ?? "?"}`}</Td>
                  <Td right>{Math.round(m.confidence * 100)}%</Td>
                  <Td>
                    <Badge tone={statusTone(m.status)}>{statusLabel(m.status)}</Badge>
                  </Td>
                  <Td>{m.matchedBy === "system" ? "Sistema" : (userName.get(m.matchedBy) ?? m.matchedBy)}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
