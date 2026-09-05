import { Fragment } from "react";
import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, StatCard, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL, formatDateTime, statusLabel } from "@/lib/format";
import { addDays, isISODate, monthOf, type ISODate } from "@/core/dates";
import {
  balanceLines,
  computeBankPeriodBalance,
  type BalanceLine,
  type BankBalanceInput,
} from "@/core/bank-balance";
import type { ReconciliationMatch } from "@/core/entities";
import { payableRemainingCents, receivableRemainingCents } from "@/core/money";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { filtersToQuery, resolveFilters } from "./_lib/filters";
import { MonthNav, formatMonthBR, isISOMonth } from "@/app/(app)/_lib/month-nav";
import { runSkillForSession } from "@/app/(app)/_lib/run-skill";
import type { ReconciliationAuditData } from "@/skills/conciliacao";
import {
  adjustPaymentDateAction,
  confirmMatchAction,
  importStatementAction,
  reconcilePaymentAction,
  rejectMatchAction,
  syncBankAction,
  undoReconciliationAction,
} from "./actions";
import { EditPayableForm } from "@/app/(app)/contas-a-pagar/_lib/edit-payable-form";
import { hasPermission } from "@/core/auth";
import { todayInTz } from "@/core/dates";

interface TargetInfo {
  label: string;
  description: string;
  amountCents: number;
  date: ISODate;
}

export default async function ConciliacaoPage({
  searchParams,
}: {
  searchParams: Promise<{
    ok?: string;
    erro?: string;
    pt?: string;
    /** Título conciliado com o formulário de vencimento aberto. */
    editar?: string;
    f_pagamento?: string;
    /** Pagamento com o pop-up de exclusão aberto. */
    excluir?: string;
    f_motivo?: string;
    /** Filtros da caixa Saldo: conta bancária e período (inclusivo). */
    conta?: string;
    de?: string;
    ate?: string;
    /** Mês da seção "Divergências do período". */
    dm?: string;
    /** Pré-filtro de "Localizar no extrato": valor em centavos e data da baixa. */
    bv?: string;
    bd?: string;
  }>;
}) {
  const sp = await searchParams;
  const { ok, erro, pt } = sp;
  const session = await requireSession();
  const { repos, clock, integrations } = await getContainer();
  // Nome do provedor de dados bancários na seção 1b (mock vs. real).
  const bankProvider = integrations.bankData.provider;
  const bankProviderLabel =
    bankProvider === "mock" ? "mock" : bankProvider === "pluggy" ? "Pluggy" : bankProvider;
  const companyId = session.company.id;
  // Fuso da empresa, nunca UTC: na virada do mês o default do filtro pularia
  // um dia. Declarado aqui porque o saldo e o card de pagamentos usam o mesmo.
  const today = todayInTz(clock.now(), session.config.timezone);

  const [bankAccounts, suggested, decided, unreconciledPage, payables, receivables, payments, receipts, suppliers, customers, users, costCenters] =
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
      // Entradas do saldo: a tela não usava recibos até a caixa existir.
      repos.receipts.listAll(companyId),
      repos.suppliers.listAll(companyId),
      repos.customers.listAll(companyId),
      repos.users.listAll(),
      // Só para exibir o centro de custo do título no formulário de vencimento
      // (que o mostra em leitura). Lista pequena, uma consulta.
      repos.costCenters.listAll(companyId),
    ]);

  const accountName = new Map(bankAccounts.map((b) => [b.id, b.name]));
  // Sem conta ativa não há o que conciliar: os selects abaixo são `required` e
  // ficariam só com a opção vazia, fazendo o navegador barrar o submit com o
  // tooltip "Selecione um item da lista" — que não diz o que fazer.
  const contasAtivas = bankAccounts.filter((b) => b.active);

  // --- Saldo do extrato conciliado ----------------------------------------
  // SALDO = saldo inicial da conta + entradas − saídas dos lançamentos
  // CONCILIADOS do extrato, no período. O extrato de uma conta é carregado
  // inteiro e recortado em memória — é o que tesouraria e relatórios já fazem,
  // e o volume de um app PME não justifica um método novo no repositório.
  const filtros = resolveFilters(sp, bankAccounts, today);
  const filtrosQuery = filtersToQuery(sp);
  const contaSelecionada = bankAccounts.find((b) => b.id === filtros.bankAccountId);
  const extratoDaConta =
    contaSelecionada && !filtros.periodoInvalido
      ? await repos.bankTransactions.listByAccount(companyId, contaSelecionada.id)
      : [];
  // O dinheiro conciliado mora em dois lugares: no registro da empresa
  // (pagamento executado, recebimento) e no extrato do banco. `decided` são os
  // matches confirmados, usados para NÃO contar duas vezes a transação do
  // extrato que já veio como pagamento.
  const entradaSaldo: BankBalanceInput | undefined =
    contaSelecionada && !filtros.periodoInvalido
      ? {
          account: contaSelecionada,
          payments,
          receipts,
          transactions: extratoDaConta,
          matches: decided,
          period: { from: filtros.from, to: filtros.to },
          timeZone: session.config.timezone,
        }
      : undefined;
  const saldo = entradaSaldo ? computeBankPeriodBalance(entradaSaldo) : undefined;
  // Os totais DERIVAM destas linhas: a lista abaixo da caixa não tem como
  // divergir do número exibido.
  const linhasDoPeriodo = entradaSaldo ? balanceLines(entradaSaldo) : [];

  // --- Divergências do período (auditoria de conciliação) ------------------
  // Leitura pura: a skill não altera nada, então a página a invoca direto, sem
  // passar pelo orquestrador (padrão de runSkillForSession).
  const mesDivergencias = isISOMonth(sp.dm) ? sp.dm : monthOf(today);
  const auditoriaRes = await runSkillForSession<ReconciliationAuditData>(
    session,
    "conciliacao_bancaria",
    {
      action: "reconciliation_audit",
      period: mesDivergencias,
      ...(sp.conta ? { bankAccountId: sp.conta } : {}),
    }
  );
  const auditoria = auditoriaRes.status === "success" ? auditoriaRes.data : null;
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const extratoById = new Map(extratoDaConta.map((t) => [t.id, t]));
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

  /**
   * O core devolve origem + id; nomear é da tela, que já tem os cadastros em
   * memória. Assim o cálculo do saldo não precisa saber o que é fornecedor.
   */
  function descreverLinha(linha: BalanceLine): { descricao: string; origem: string } {
    if (linha.origin === "payment") {
      const pay = paymentById.get(linha.sourceId);
      const payable = pay ? payableById.get(pay.payableId) : undefined;
      const fornecedor = payable ? supplierName.get(payable.supplierId) : undefined;
      return {
        descricao: [fornecedor, payable?.description].filter(Boolean).join(" — ") || "Pagamento",
        origem: "Pagamento",
      };
    }
    if (linha.origin === "receipt") {
      const rec = receiptById.get(linha.sourceId);
      const receivable = rec ? receivableById.get(rec.receivableId) : undefined;
      const cliente = receivable ? customerName.get(receivable.customerId) : undefined;
      return {
        descricao: [cliente, receivable?.description].filter(Boolean).join(" — ") || "Recebimento",
        origem: "Recebimento",
      };
    }
    const tx = extratoById.get(linha.sourceId);
    return { descricao: tx?.description ?? linha.sourceId, origem: "Extrato" };
  }

  function resolveTarget(match: ReconciliationMatch): TargetInfo | null {
    // Despesa bancária (tarifa/IOF/juros) não tem título do outro lado: o alvo
    // é a própria transação, e por isso vem SEM targetId.
    if (match.targetType === "bank_fee") {
      const tx = txById.get(match.bankTransactionId);
      return {
        label: "Despesa bancária",
        description: tx ? tx.description : `Transação ${match.bankTransactionId}`,
        amountCents: match.amountCents ?? (tx ? Math.abs(tx.amountCents) : 0),
        date: tx?.date ?? "",
      };
    }
    if (!match.targetId) return null;
    if (match.targetType === "payable") {
      const p = payableById.get(match.targetId);
      if (!p) return null;
      return {
        label: "Título a pagar",
        description: `${supplierName.get(p.supplierId) ?? p.supplierId} — ${p.description}`,
        amountCents: payableRemainingCents(p),
        date: p.dueDate,
      };
    }
    if (match.targetType === "receivable") {
      const r = receivableById.get(match.targetId);
      if (!r) return null;
      return {
        label: "Título a receber",
        description: `${customerName.get(r.customerId) ?? r.customerId} — ${r.description}`,
        amountCents: receivableRemainingCents(r),
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

  const recentDecided = [...decided]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 15);
  // "Localizar no extrato": recorta as não conciliadas em torno do valor e da
  // data da baixa, usando as tolerâncias da empresa — o banco arredonda tarifa
  // e leva dias para publicar, então casar exato acharia pouco.
  const buscaValor = sp.bv ? Number(sp.bv) : undefined;
  const buscaData = sp.bd && isISODate(sp.bd) ? sp.bd : undefined;
  const buscando = buscaValor !== undefined && Number.isFinite(buscaValor) && buscaData;
  const tolValor = session.config.reconciliationAmountToleranceCents;
  const tolDias = session.config.reconciliationDateToleranceDays;
  const unreconciledRows = [...unreconciledPage.items]
    .filter((t) => {
      if (!buscando) return true;
      const casaValor = Math.abs(Math.abs(t.amountCents) - Math.abs(buscaValor)) <= tolValor;
      const casaData =
        t.date >= addDays(buscaData, -tolDias) && t.date <= addDays(buscaData, tolDias);
      return casaValor && casaData;
    })
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));

  // --- Pagamentos aprovados aguardando conciliação -------------------------
  // A aprovação autoriza mas não baixa: o título só é quitado aqui, com a data
  // real em que o dinheiro saiu. Ordena pelo vencimento (o mais urgente antes).
  const podeConciliar = hasPermission(session.membership.role, "payment.execute");
  // --- Ações do card "Conciliados" ---------------------------------------
  // Corrigir a data e desfazer a conciliação mexem no PAGAMENTO: as duas usam
  // payment.execute, a mesma permissão de conciliar.
  const podeCorrigirPagamento = podeConciliar;
  const costCenterLabelById = new Map(
    costCenters.map((cc) => [cc.id, `${cc.code} — ${cc.name}`])
  );
  const centsToInput = (cents: number): string => (cents / 100).toFixed(2).replace(".", ",");

  // Chave por PAGAMENTO, não por título: um título pode ter dois pagamentos
  // conciliados (baixa parcial), e por id de título as duas linhas abririam o
  // formulário ao mesmo tempo.
  const editarId = sp.editar?.trim() || undefined;
  const editandoPayment = editarId ? paymentById.get(editarId) : undefined;
  const editandoPayable = editandoPayment
    ? payableById.get(editandoPayment.payableId)
    : undefined;
  const editandoDocumento = editandoPayable?.documentId
    ? await repos.documents.getById(companyId, editandoPayable.documentId)
    : null;

  const excluirId = sp.excluir?.trim() || undefined;
  const excluirPayment =
    excluirId && paymentById.get(excluirId)?.status === "executed"
      ? paymentById.get(excluirId)
      : undefined;
  const excluirPayable = excluirPayment ? payableById.get(excluirPayment.payableId) : undefined;

  // Pagamentos JÁ conciliados, do mais recente para o mais antigo. A data
  // exibida é a do pagamento informada na conciliação (executedAt), convertida
  // para o fuso da empresa — nunca UTC, senão a data pularia um dia.
  const CONCILIADOS_RECENTES = 30;
  const conciliados = payments
    .filter((pay) => pay.status === "executed" && pay.executedAt)
    .sort((a, b) => (b.executedAt ?? "").localeCompare(a.executedAt ?? ""))
    .slice(0, CONCILIADOS_RECENTES)
    .map((pay) => ({
      pay,
      payable: payableById.get(pay.payableId),
      data: todayInTz(new Date(pay.executedAt as string), session.config.timezone),
    }));

  const aprovados = payments
    .filter((pay) => pay.status === "approved")
    .map((pay) => ({ pay, payable: payableById.get(pay.payableId) }))
    .filter((r): r is { pay: (typeof payments)[number]; payable: NonNullable<typeof r.payable> } =>
      Boolean(r.payable)
    )
    .sort((a, b) => a.payable.dueDate.localeCompare(b.payable.dueDate));

  return (
    <div>
      <PageHeader
        title="Conciliação bancária"
        subtitle="Importação de extratos (OFX/CSV), conciliação automática com grau de confiança e revisão humana das sugestões."
      />
      <Flash ok={ok} erro={erro} />

      {/* Saldo do EXTRATO conciliado. Mede coisa diferente do card
          "Conciliados" logo abaixo: conciliar um pagamento aqui não cria
          transação bancária nenhuma — só a importação do extrato cria. Sem essa
          distinção no rótulo, o saldo parece errado para quem lança pagamentos
          sem importar OFX. */}
      <Card className="mb-6" title="Saldo conciliado">
        <form method="get" action="/conciliacao" className="grid gap-4 md:grid-cols-4">
          <Field label="Conta bancária">
            <select
              name="conta"
              className={inputClass}
              defaultValue={filtros.bankAccountId ?? ""}
              disabled={contasAtivas.length === 0}
            >
              {contasAtivas.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.accountNumberMasked})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Data inicial">
            <input type="date" name="de" defaultValue={filtros.from} className={inputClass} />
          </Field>
          <Field label="Data final">
            <input type="date" name="ate" defaultValue={filtros.to} className={inputClass} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Filtrar</Button>
            <Link
              href="/conciliacao"
              className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
            >
              Limpar
            </Link>
          </div>
        </form>

        {filtros.periodoInvalido ? (
          <p className="mt-4 text-sm text-[var(--crit)]">
            Data inicial maior que a data final.
          </p>
        ) : !contaSelecionada || !saldo ? (
          <EmptyState message="Cadastre uma conta bancária ativa para ver o saldo." />
        ) : (
          <>
            <div className="mt-4 max-w-xs">
              <StatCard
                label="Saldo"
                value={formatBRL(saldo.balanceCents)}
                tone={saldo.balanceCents < 0 ? "crit" : "ok"}
                hint={`${contaSelecionada.name} · ${formatBR(filtros.from)} a ${formatBR(filtros.to)}`}
              />
            </div>
            <div className="mt-3 space-y-1 text-sm text-[var(--ink-muted)]">
              <p>
                Entradas: {formatBRL(saldo.inflowCents)} ({saldo.inflowCount} lançamentos)
              </p>
              <p>
                Saídas: {formatBRL(saldo.outflowCents)} ({saldo.outflowCount} lançamentos)
              </p>
              <p>Total de lançamentos conciliados no período: {saldo.reconciledCount}</p>
            </div>

            {/* O extrato que sustenta o número. Sem isto, o saldo é um número
                sem lastro visível: as conciliadas somem do card 3 no instante
                em que são conciliadas e não reaparecem em lugar nenhum. */}
            {linhasDoPeriodo.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-[var(--brand)]">
                  Ver os {linhasDoPeriodo.length} lançamentos que compõem o saldo
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <Table
                    headers={["Data", "Descrição", "Entrada", "Saída", "Origem"]}
                    align={["l", "l", "r", "r", "l"]}
                  >
                    {linhasDoPeriodo.map((l) => {
                      const rotulo = descreverLinha(l);
                      return (
                        <tr key={`${l.origin}_${l.sourceId}`}>
                          <Td className="whitespace-nowrap">{formatBR(l.date)}</Td>
                          <Td>{rotulo.descricao}</Td>
                          <Td right className="text-[var(--ok)]">
                            {l.amountCents > 0 ? formatBRL(l.amountCents) : ""}
                          </Td>
                          <Td right className="text-[var(--crit)]">
                            {l.amountCents < 0 ? formatBRL(Math.abs(l.amountCents)) : ""}
                          </Td>
                          <Td>{rotulo.origem}</Td>
                        </tr>
                      );
                    })}
                  </Table>
                </div>
              </details>
            ) : null}
            <p className="mt-3 text-xs text-[var(--ink-muted)]">
              Saldo = saldo inicial da conta ({formatBRL(saldo.openingBalanceCents)}, em{" "}
              {formatBR(contaSelecionada.openingBalanceDate)}) + entradas − saídas. O saldo inicial
              entra por inteiro, qualquer que seja o período escolhido. Entram pagamentos
              executados, recebimentos e as linhas do extrato conciliadas que não correspondem a
              nenhum deles (tarifa, IOF, juros do banco) — o que já foi conciliado contra um
              pagamento não é contado duas vezes.
            </p>
          </>
        )}
      </Card>

      {/* Divergências do período. A auditoria é LEITURA: nenhum botão aqui
          corrige nada — os caminhos de correção são os que já existem
          (conciliar, estornar). */}
      <Card
        className="mb-6"
        title={`Divergências do período — ${formatMonthBR(mesDivergencias)}`}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <MonthNav
            basePath="/conciliacao"
            selected={mesDivergencias}
            latest={monthOf(today)}
            param="dm"
            extraQuery={{ conta: sp.conta, de: sp.de, ate: sp.ate }}
          />
          <Link
            href={`/api/v1/reports/reconciliation_audit?period=${mesDivergencias}&format=xlsx`}
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
          >
            Exportar
          </Link>
        </div>

        {!auditoria ? (
          <EmptyState message="Não foi possível carregar as divergências deste período." />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Extrato sem explicação"
                value={String(auditoria.totals.unexplainedCount)}
                hint={formatBRL(auditoria.totals.unexplainedCents)}
                tone={auditoria.totals.unexplainedCount > 0 ? "warn" : "ok"}
              />
              <StatCard
                label="Baixas sem lastro"
                value={String(auditoria.totals.settlementsWithoutBankCount)}
                hint={formatBRL(auditoria.totals.settlementsWithoutBankCents)}
                tone={auditoria.totals.settlementsWithoutBankCount > 0 ? "crit" : "ok"}
              />
              <StatCard
                label="Valores divergentes"
                value={String(auditoria.totals.amountMismatchCount)}
                tone={auditoria.totals.amountMismatchCount > 0 ? "warn" : "ok"}
              />
              <StatCard
                label="Contas com saldo divergente"
                value={String(auditoria.totals.balanceMismatchCount)}
                tone={auditoria.totals.balanceMismatchCount > 0 ? "crit" : "ok"}
              />
            </div>

            {/* Pendente de cobertura NÃO é divergência: é baixa recente demais
                para o extrato importado. Fica em linha informativa, fora dos
                cartões, para não ser lida como problema. */}
            {auditoria.totals.pendingCoverageCount > 0 ? (
              <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink-muted)]">
                {auditoria.totals.pendingCoverageCount} baixa(s) aguardam a importação do extrato —
                ainda não podiam aparecer nele.{" "}
                {auditoria.coverage
                  .map((c) =>
                    c.coverageDate
                      ? `${c.bankName}: extrato até ${formatBR(c.coverageDate)}`
                      : `${c.bankName}: sem extrato importado`
                  )
                  .join(" · ")}
                . <a href="#importar-extrato" className="text-[var(--brand)] underline">Importar OFX</a>
              </p>
            ) : null}

            {auditoria.totals.unexplainedCount === 0 &&
            auditoria.totals.settlementsWithoutBankCount === 0 &&
            auditoria.totals.amountMismatchCount === 0 &&
            auditoria.totals.balanceMismatchCount === 0 ? (
              <div className="mt-4">
                <EmptyState
                  message={`Nenhuma divergência em ${formatMonthBR(mesDivergencias)}. ${auditoria.coverage
                    .map((c) =>
                      c.coverageDate
                        ? `${c.bankName}: extrato conferido até ${formatBR(c.coverageDate)}`
                        : `${c.bankName}: nenhum extrato importado`
                    )
                    .join(" · ")}.`}
                />
              </div>
            ) : null}

            {auditoria.settlementsWithoutBank.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-semibold">Baixas sem lastro no extrato</h3>
                <div className="overflow-x-auto">
                  <Table
                    headers={["Data", "Contraparte", "Descrição", "Valor", "Origem", "Ações"]}
                    align={["l", "l", "l", "r", "l", "l"]}
                  >
                    {auditoria.settlementsWithoutBank.map((d) => (
                      <tr key={`${d.kind}_${d.id}`}>
                        <Td className="whitespace-nowrap">{formatBR(d.date)}</Td>
                        <Td>{d.counterparty}</Td>
                        <Td>{d.description}</Td>
                        <Td right>{formatBRL(d.amountCents)}</Td>
                        <Td>
                          {d.kind === "payment"
                            ? "Pagamento"
                            : d.kind === "receipt"
                              ? "Recebimento"
                              : "Baixa manual"}
                        </Td>
                        <Td className="whitespace-nowrap text-xs">
                          {/* Pré-filtra as não conciliadas pelo valor e pela data,
                              com as tolerâncias da empresa. */}
                          <Link
                            href={`/conciliacao?dm=${mesDivergencias}&bv=${d.amountCents}&bd=${d.date}#nao-conciliadas`}
                            className="text-[var(--brand)] underline"
                          >
                            Localizar no extrato
                          </Link>
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </div>
              </div>
            ) : null}

            {auditoria.unexplainedBankTransactions.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-semibold">Extrato sem explicação</h3>
                <div className="overflow-x-auto">
                  <Table
                    headers={["Data", "Descrição", "Valor", "Situação"]}
                    align={["l", "l", "r", "l"]}
                  >
                    {auditoria.unexplainedBankTransactions.map((t) => (
                      <tr key={t.id}>
                        <Td className="whitespace-nowrap">{formatBR(t.date)}</Td>
                        <Td>{t.description}</Td>
                        <Td right className={t.amountCents < 0 ? "text-[var(--crit)]" : "text-[var(--ok)]"}>
                          {formatBRL(t.amountCents)}
                        </Td>
                        <Td>
                          <Badge tone={t.hasSuggestion ? "warn" : "neutral"}>
                            {t.hasSuggestion ? "Tem sugestão" : "Sem sugestão"}
                          </Badge>
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </div>
              </div>
            ) : null}

            {auditoria.amountMismatches.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-semibold">Valores divergentes</h3>
                <div className="overflow-x-auto">
                  <Table
                    headers={["Alvo", "Aplicado", "Esperado", "Diferença"]}
                    align={["l", "r", "r", "r"]}
                  >
                    {auditoria.amountMismatches.map((m) => (
                      <tr key={m.matchId}>
                        <Td>{`${m.targetType} ${m.targetId ?? ""}`.trim()}</Td>
                        <Td right>{formatBRL(m.appliedCents)}</Td>
                        <Td right>{formatBRL(m.expectedCents)}</Td>
                        <Td right className="text-[var(--crit)]">{formatBRL(m.diffCents)}</Td>
                      </tr>
                    ))}
                  </Table>
                </div>
              </div>
            ) : null}

            {auditoria.balanceChecks.length > 0 ? (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-semibold">Saldo do banco × saldo do app</h3>
                <div className="overflow-x-auto">
                  <Table
                    headers={["Conta", "Data-base", "Banco", "App", "Diferença", "Sem explicação"]}
                    align={["l", "l", "r", "r", "r", "r"]}
                  >
                    {auditoria.balanceChecks.map((b) => (
                      <tr key={b.bankAccountId}>
                        <Td>{b.bankName}</Td>
                        <Td className="whitespace-nowrap">{formatBR(b.asOf)}</Td>
                        <Td right>{formatBRL(b.ledgerBalanceCents)}</Td>
                        <Td right>{formatBRL(b.computedBalanceCents)}</Td>
                        <Td right>{formatBRL(b.diffCents)}</Td>
                        <Td right className={b.residualCents !== 0 ? "text-[var(--crit)]" : ""}>
                          {formatBRL(b.residualCents)}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </div>
              </div>
            ) : null}

            {auditoriaRes.assumptions.length > 0 ? (
              <ul className="mt-4 space-y-1 text-xs text-[var(--ink-muted)]">
                {auditoriaRes.assumptions.map((a, i) => (
                  <li key={i}>· {a}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Card>

      {/* Pagamentos APROVADOS aguardando conciliação. A aprovação autoriza a
          saída; a baixa só acontece aqui, com a data real do pagamento — é ela
          que decide "Pago" (até o vencimento) ou "Pago Atrasado" (depois dele).
          Cada linha tem a caixa de data (com o calendário nativo, em tempo
          real), a caixa de confirmação — que fica VERDE quando marcada — e o
          botão que registra a conciliação. */}
      <Card
        className="mb-6"
        title={`Pagamentos aprovados aguardando conciliação (${aprovados.length})`}
      >
        {aprovados.length === 0 ? (
          <EmptyState message="Nenhum pagamento aprovado aguardando conciliação." />
        ) : !podeConciliar ? (
          <p className="text-sm text-[var(--ink-muted)]">
            {aprovados.length} pagamento(s) aguardando conciliação. Seu papel não permite
            conciliar pagamentos.
          </p>
        ) : (
          <div className="space-y-3">
            {aprovados.map(({ pay, payable }) => (
              <div
                key={pay.id}
                className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-[var(--line)] p-3"
              >
                <div className="min-w-56">
                  <p className="text-sm font-medium">
                    {supplierName.get(payable.supplierId) ?? payable.supplierId} —{" "}
                    {payable.description}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    Vencimento {formatBR(payable.dueDate)} · Valor{" "}
                    <strong className="tabular">{formatBRL(pay.amountCents)}</strong> ·{" "}
                    {accountName.get(pay.bankAccountId) ?? pay.bankAccountId} · Aprovado
                  </p>
                </div>
                <form
                  action={reconcilePaymentAction}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="paymentId" value={pay.id} />
                  <Field label="Data do pagamento">
                    {/* input[type=date]: calendário nativo do navegador, aberto
                        no ícone ao lado do campo. `max` barra data futura já na
                        tela (a skill valida de novo no servidor). */}
                    <input
                      type="date"
                      name="paymentDate"
                      required
                      defaultValue={today}
                      max={today}
                      className={`${inputClass} md:w-44`}
                    />
                  </Field>
                  {/* Caixa de confirmação: marcada, fica verde — o registro
                      visual de que a conciliação foi confirmada. `required`
                      impede conciliar sem confirmar (revalidado no servidor). */}
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm has-[:checked]:border-[var(--ok)] has-[:checked]:bg-emerald-50 has-[:checked]:font-medium has-[:checked]:text-[var(--ok)]">
                    <input
                      type="checkbox"
                      name="confirmado"
                      required
                      className="h-4 w-4 accent-[var(--ok)]"
                    />
                    Conciliado
                  </label>
                  <Button type="submit">Registrar conciliação</Button>
                </form>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Conciliados: o que a tela de Conciliação não guardava. A linha sai do
          card de pendentes assim que é registrada, e o histórico logo abaixo é
          de conciliação de EXTRATO bancário — outro fluxo. Este card é o
          registro dos pagamentos conciliados aqui. */}
      <Card
        className="mb-6"
        title={`Conciliados (${conciliados.length})`}
      >
        {conciliados.length === 0 ? (
          <EmptyState message="Nenhum pagamento conciliado ainda." />
        ) : (
          <Table
            headers={[
              "Data do pagamento",
              "Fornecedor",
              "Título",
              "Valor",
              "Conciliado por",
              "Ações",
            ]}
            align={["l", "l", "l", "r", "l", "l"]}
          >
            {conciliados.map(({ pay, payable, data }) => (
              <Fragment key={pay.id}>
                <tr>
                  <Td>{formatBR(data)}</Td>
                  <Td>
                    {payable
                      ? (supplierName.get(payable.supplierId) ?? payable.supplierId)
                      : "—"}
                  </Td>
                  <Td>{payable?.description ?? pay.payableId}</Td>
                  <Td right>{formatBRL(pay.amountCents)}</Td>
                  <Td>
                    {pay.executedBy ? (userName.get(pay.executedBy) ?? pay.executedBy) : "—"}
                  </Td>
                  {/* Editar (✎) abre o formulário do título na linha, só com o
                      vencimento liberado. Excluir (🗑) abre o pop-up que desfaz
                      a conciliação. Ambos são GET — não agem por si. */}
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    <div className="flex flex-nowrap items-center gap-1">
                      {podeCorrigirPagamento && payable ? (
                        <form method="get" action="/conciliacao" className="inline">
                          <input
                            type="hidden"
                            name="editar"
                            value={editarId === pay.id ? "" : pay.id}
                          />
                          <input type="hidden" name="conta" value={sp.conta ?? ""} />
                          <input type="hidden" name="de" value={sp.de ?? ""} />
                          <input type="hidden" name="ate" value={sp.ate ?? ""} />
                          <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                            <Button variant="warn" type="submit">
                              {editarId === pay.id ? "Fechar" : "✎"}
                            </Button>
                          </span>
                        </form>
                      ) : null}
                      {podeConciliar ? (
                        <form method="get" action="/conciliacao" className="inline">
                          <input type="hidden" name="excluir" value={pay.id} />
                          <input type="hidden" name="conta" value={sp.conta ?? ""} />
                          <input type="hidden" name="de" value={sp.de ?? ""} />
                          <input type="hidden" name="ate" value={sp.ate ?? ""} />
                          <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                            <Button variant="danger" type="submit">
                              🗑
                            </Button>
                          </span>
                        </form>
                      ) : null}
                      {!podeCorrigirPagamento && !podeConciliar ? (
                        <span className="text-[var(--ink-muted)]">—</span>
                      ) : null}
                    </div>
                  </Td>
                </tr>
                {editandoPayable && editarId === pay.id ? (
                  <tr>
                    {/* <td> cru por causa do colSpan, que o Td não expõe. */}
                    <td className="px-2 py-2 align-middle" colSpan={6}>
                      <EditPayableForm
                        mode="paymentDateOnly"
                        action={adjustPaymentDateAction}
                        payable={{
                          id: editandoPayable.id,
                          supplierName:
                            supplierName.get(editandoPayable.supplierId) ??
                            editandoPayable.supplierId,
                          description: editandoPayable.description,
                          amount: centsToInput(editandoPayable.amountCents),
                          documentNumber: editandoDocumento?.number,
                          issueDate: editandoPayable.issueDate,
                          dueDate: editandoPayable.dueDate,
                          supplierCategory: editandoPayable.supplierCategory ?? "",
                          costClassification: editandoPayable.costClassification ?? "",
                          costCenterId: editandoPayable.costCenterId ?? "",
                          costCenterLabel: editandoPayable.costCenterId
                            ? costCenterLabelById.get(editandoPayable.costCenterId)
                            : undefined,
                          notes: editandoPayable.notes ?? "",
                          installmentNumber: editandoPayable.installmentNumber,
                          installmentCount: editandoPayable.installmentCount,
                          scheduled: false,
                          // A data que a coluna exibe, já no fuso da empresa.
                          paymentDate: data,
                          paymentDateMax: today,
                        }}
                        prefill={{ paymentDate: sp.f_pagamento }}
                        cancelHref={`/conciliacao?${filtrosQuery.slice(1)}`}
                        hiddenFields={{ paymentId: pay.id }}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </Table>
        )}
      </Card>

      {/* POP-UP de confirmação da exclusão do conciliado. Mesmo padrão do
          estorno em Aprovações: sobreposição renderizada no servidor, aberta
          por ?excluir=<paymentId> e fechada voltando para /conciliacao. */}
      {excluirPayment && excluirPayable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-lg p-4 shadow-xl">
            <h2 className="text-base font-semibold text-[var(--crit)]">
              Excluir lançamento conciliado
            </h2>
            <p className="mt-2 text-sm">
              A conciliação de{" "}
              <strong className="tabular">{formatBRL(excluirPayment.amountCents)}</strong>{" "}
              {supplierName.get(excluirPayable.supplierId) ?? excluirPayable.supplierId} será
              desfeita.
            </p>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              {excluirPayable.description} · vencimento {formatBR(excluirPayable.dueDate)}
            </p>
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              O título <strong>volta para Contas a pagar</strong> com a situação da regra
              atual, o lançamento contábil é <strong>estornado</strong> por um lançamento
              inverso, e a aprovação que originou esta conciliação sai do{" "}
              <strong>Histórico de decisões</strong>. Nada é apagado: tudo permanece
              registrado em Auditoria.
            </p>
            <form action={undoReconciliationAction} className="mt-3">
              <input type="hidden" name="paymentId" value={excluirPayment.id} />
              <Field label="Motivo da exclusão">
                <input
                  name="reason"
                  required
                  autoFocus
                  defaultValue={sp.f_motivo ?? ""}
                  className={inputClass}
                  placeholder="Ex.: conciliado com a data errada"
                />
              </Field>
              <div className="mt-3 flex items-center gap-2">
                <Button variant="danger" type="submit">
                  Confirmar exclusão
                </Button>
                <Link
                  href={`/conciliacao?${filtrosQuery.slice(1)}`}
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                >
                  Voltar
                </Link>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <Card id="importar-extrato" className="mb-6" title="1 — Importar extrato">
        {contasAtivas.length === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]">
            Nenhuma conta bancária ativa.{" "}
            <Link href="/cadastros/contas-bancarias" className="text-[var(--brand)] underline">
              Cadastrar conta bancária
            </Link>{" "}
            antes de importar extratos.
          </p>
        ) : (
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
        )}
      </Card>

      <Card className="mb-6" title={`1b — Sincronizar com o banco (${bankProviderLabel})`}>
        {contasAtivas.length === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]">
            Nenhuma conta bancária ativa.{" "}
            <Link href="/cadastros/contas-bancarias" className="text-[var(--brand)] underline">
              Cadastrar conta bancária
            </Link>{" "}
            antes de sincronizar.
          </p>
        ) : (
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
            {bankProvider === "mock" ? (
              <>
                Busca transações via provedor de dados bancários configurado (porta de integração).
                O provedor atual é <strong>mock</strong>: gera um extrato sintético determinístico —
                nenhum banco real é consultado.
              </>
            ) : (
              <>
                Busca as transações <strong>reais</strong> da conta via{" "}
                <strong>{bankProviderLabel}</strong> (Open Finance) — somente lançamentos
                liquidados, em BRL — e grava o saldo declarado pelo banco no lote.
              </>
            )}{" "}
            Sincronizar de novo o mesmo período não duplica transações.
          </p>
        </form>
        )}
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

      <Card
        id="nao-conciliadas"
        className="mb-6"
        title={`3 — Transações não conciliadas (${unreconciledPage.total})`}
      >
        {buscando ? (
          <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-[var(--ink-muted)]">
            Filtrando por {formatBRL(buscaValor as number)} ± {formatBRL(tolValor)} em torno de{" "}
            {formatBR(buscaData as ISODate)} ± {tolDias} dia(s).
            <Link
              href={`/conciliacao?dm=${mesDivergencias}#nao-conciliadas`}
              className="text-[var(--brand)] underline"
            >
              Limpar
            </Link>
          </p>
        ) : null}
        {unreconciledRows.length === 0 ? (
          <EmptyState
            message={
              buscando
                ? "Nenhuma transação não conciliada bate com esse valor e data."
                : "Todas as transações importadas estão conciliadas."
            }
          />
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
        <Pager
          page={unreconciledPage}
          basePath="/conciliacao"
          param="pt"
          extraQuery={{ conta: sp.conta, de: sp.de, ate: sp.ate }}
        />
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
