import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { receiptIsActive } from "@/core/money";
import { hasPermission } from "@/core/auth";
import { formatBR, formatBRL } from "@/lib/format";
import {
  addDays,
  endOfMonth,
  isISODate,
  maxDate,
  minDate,
  startOfMonth,
  todayInTz,
  type ISODate,
} from "@/core/dates";
import type { ReceivableStatus } from "@/core/entities";
import { receivableRemainingCents } from "@/core/money";
import {
  deriveReceivableSituation,
  hasPartialReceipt,
  type ReceivableSituation,
} from "@/lib/receivable-situation";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { EditReceivableForm } from "./_lib/edit-receivable-form";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import {
  adjustReceiptDateAction,
  cancelReceivableAction,
  createReceivableAction,
  issueChargeAction,
  registerReceiptAction,
  reverseReceiptAction,
  updateReceivableAction,
} from "./actions";
import { MoneyInput } from "@/components/money-input";
import { filtersToQuery } from "./_lib/filters";
// Mesmos três ícones da barra de Contas a Pagar — um arquivo só para os dois.
import { IconeExportar, IconeImportar, IconeImprimir } from "@/app/(app)/contas-a-pagar/_lib/icons";

// Situações DERIVADAS usadas como filtro (mesmo desenho de /contas-a-pagar).
// Cada uma vira um recorte de status + intervalo de vencimento aplicado NO BANCO
// (listPage) — nunca em memória. "Recebido em Atraso" não é filtrável no
// listPage atual (compara Receipt.receivedDate com dueDate) — fica só como badge.
type SituacaoFiltro = "todos" | "a_vencer" | "hoje" | "atrasado" | "recebido" | "cancelado";

const SITUACAO_FILTERS: Array<{ value: SituacaoFiltro; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "a_vencer", label: "A Vencer" },
  { value: "hoje", label: "Hoje" },
  { value: "atrasado", label: "Atrasado" },
  { value: "recebido", label: "Recebido" },
  { value: "cancelado", label: "Cancelados" },
];

// Status "em aberto" de um recebível (mesma noção da skill, sem alterá-la):
// as situações por data (A Vencer/Hoje/Atrasado) recaem sobre estes. Também é a
// condição de "pode receber/cobrar" nas linhas.
const RECEIVABLE_OPEN: ReceivableStatus[] = ["open", "partially_received"];

// Tom do Badge por situação (usa as CSS vars do design system via Badge tone).
const SITUACAO_TONE: Record<ReceivableSituation, "neutral" | "ok" | "warn" | "crit"> = {
  Atrasado: "crit",
  Hoje: "warn",
  "A Vencer": "neutral",
  Recebido: "ok", // recebido ANTES do vencimento — verde
  "Recebido no Vencimento": "warn", // recebido no dia do vencimento — amarelo
  "Recebido em Atraso": "crit", // recebido depois do vencimento — vermelho
  Cancelado: "neutral", // apagado
};

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export default async function ContasAReceberPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    p?: string;
    ok?: string;
    erro?: string;
    ano?: string;
    mes?: string;
    cliente?: string;
    de?: string;
    ate?: string;
    // Reexibição do formulário "Novo título" após falha de validação (prefixo nt_).
    nt_erro?: string;
    nt_cliente?: string;
    nt_descricao?: string;
    nt_valor?: string;
    nt_emissao?: string;
    nt_vencimento?: string;
    nt_parcelas?: string;
    nt_categoria?: string;
    nt_centrocusto?: string;
    nt_metodo?: string;
    nt_observacao?: string;
    // Reexibição do form de RECEBIMENTO (inline por linha) após falha (rc_).
    rc_id?: string;
    rc_valor?: string;
    rc_data?: string;
    rc_metodo?: string;
    rc_conta?: string;
    // Cancelamento inline por linha (?excluir=<id>) e motivo preservado em erro.
    excluir?: string;
    f_motivo?: string;
    /** Edição do título (espelho de Contas a pagar). */
    editar?: string;
    f_descricao?: string;
    f_emissao?: string;
    f_vencimento?: string;
    f_valor?: string;
    f_categoria?: string;
    f_centrocusto?: string;
    f_notas?: string;
    /** Painel de recebimentos de um título. */
    recebimentos?: string;
    /** Pop-up de estorno de um recebimento. */
    estornar?: string;
    f_motivo_estorno?: string;
  }>;
}) {
  const sp = await searchParams;
  const { status, p, ok, erro, ano, mes, cliente, de, ate } = sp;
  const queryFiltros = filtersToQuery(sp);
  const rcErroId = sp.rc_id?.trim() || undefined; // linha cujo recebimento falhou
  const excluir = sp.excluir?.trim() || undefined; // linha em confirmação de cancelamento
  // Erro de datas liga o destaque de Emissão/Vencimento no form de novo título.
  const ntDateError = sp.nt_erro === "data";
  const ntDateFieldClass = ntDateError
    ? `${inputClass} border-[var(--crit)] focus:border-[var(--crit)]`
    : inputClass;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const canCancel = hasPermission(session.membership.role, "receivable.cancel");
  const today = todayInTz(clock.now(), session.config.timezone);

  const filter: SituacaoFiltro = SITUACAO_FILTERS.some((f) => f.value === status)
    ? (status as SituacaoFiltro)
    : "todos";

  // Precedência: Período (de/ate) tem prioridade sobre Ano/Mês (regra no servidor).
  const deIso = de && isISODate(de) ? de : undefined;
  const ateIso = ate && isISODate(ate) ? ate : undefined;
  if (deIso && ateIso && deIso > ateIso) {
    redirect(`/contas-a-receber?erro=${encodeURIComponent("Data inicial maior que a final.")}`);
  }

  const anoNum = ano && /^\d{4}$/.test(ano) ? Number(ano) : undefined;
  const mesNum = mes && /^\d{1,2}$/.test(mes) && Number(mes) >= 1 && Number(mes) <= 12
    ? Number(mes)
    : undefined;

  // Intervalo de vencimento vindo dos filtros de PERÍODO (de/ate ou ano/mês).
  let periodoFrom: ISODate | undefined;
  let periodoTo: ISODate | undefined;
  if (deIso || ateIso) {
    periodoFrom = deIso;
    periodoTo = ateIso;
  } else if (anoNum) {
    if (mesNum) {
      const monthKey = `${anoNum}-${String(mesNum).padStart(2, "0")}`;
      periodoFrom = startOfMonth(monthKey);
      periodoTo = endOfMonth(monthKey); // último dia correto (fev/30 dias) via helper
    } else {
      periodoFrom = `${anoNum}-01-01`;
      periodoTo = `${anoNum}-12-31`;
    }
  }

  // Situação → recorte de status + intervalo de vencimento relativo a HOJE.
  // Tudo no banco (listPage): nunca filtra em memória depois de paginar.
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  let statusFilter: ReceivableStatus[] | undefined;
  let situacaoFrom: ISODate | undefined;
  let situacaoTo: ISODate | undefined;
  switch (filter) {
    case "a_vencer":
      statusFilter = RECEIVABLE_OPEN;
      situacaoFrom = tomorrow;
      break;
    case "hoje":
      statusFilter = RECEIVABLE_OPEN;
      situacaoFrom = today;
      situacaoTo = today;
      break;
    case "atrasado":
      statusFilter = RECEIVABLE_OPEN;
      situacaoTo = yesterday;
      break;
    case "recebido":
      statusFilter = ["received"];
      break;
    case "cancelado":
      statusFilter = ["canceled"];
      break;
    case "todos":
      statusFilter = undefined;
      break;
  }

  // Combina o intervalo da situação com o do período: INTERSEÇÃO (from = max,
  // to = min), para os dois filtros valerem juntos sem um sobrescrever o outro.
  const dueFrom =
    situacaoFrom && periodoFrom
      ? maxDate(situacaoFrom, periodoFrom)
      : (situacaoFrom ?? periodoFrom);
  const dueTo =
    situacaoTo && periodoTo ? minDate(situacaoTo, periodoTo) : (situacaoTo ?? periodoTo);

  const customerId = cliente || undefined;

  const [page, customers, categories, bankAccounts, allReceivables, receipts, costCenters] =
    await Promise.all([
      // Listagem paginada no repositório (volumetria) — ordem: vencimento asc.
      // Filtros de status/cliente/vencimento aplicados no banco.
      repos.receivables.listPage(companyId, {
        offset: pageOffset(p),
        limit: PAGE_SIZE,
        statuses: statusFilter,
        customerId,
        dueFrom,
        dueTo,
      }),
      repos.customers.listAll(companyId),
      repos.categories.listAll(companyId),
      repos.bankAccounts.listAll(companyId),
      // Só para derivar os anos existentes nos títulos (lista de anos é pequena).
      repos.receivables.listAll(companyId),
      // Recebimentos: para a data de quitação (situação "Recebido em Atraso").
      // UMA consulta; monta-se um Map por receivableId (sem getById em loop).
      repos.receipts.listAll(companyId),
      // Centros de custo para o select do formulário e a coluna (carregado uma vez).
      repos.costCenters.listAll(companyId),
    ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const incomeCategories = categories.filter((c) => c.kind === "income" && c.active);
  const activeAccounts = bankAccounts.filter((b) => b.active);
  const rows = page.items;
  // Código do centro de custo por id (para a coluna da listagem — todos, não só ativos,
  // pois um título antigo pode apontar para um centro já desativado).
  const costCenterCode = new Map(costCenters.map((c) => [c.id, c.code]));
  // Centros ATIVOS cujo destino serve a este lado. "both" atende os dois — é
  // o valor de quem foi cadastrado antes do campo existir, então nada some
  // sem alguém ter escolhido.
  const costCenterOptions = costCenters
    .filter((c) => c.active && (c.scope === "receivable" || c.scope === "both"))
    .sort((a, b) => a.code.localeCompare(b.code, "pt-BR"))
    .map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));

  // --- Edição, recebimentos e estorno --------------------------------------
  // Editável = título sem recebimento e não encerrado (espelha a regra da
  // skill, que recusa alterar título com dinheiro baixado).
  const podeEditar = hasPermission(session.membership.role, "receivable.create");
  const isEditable = (rec: (typeof rows)[number]): boolean =>
    rec.status !== "received" && rec.status !== "canceled" && rec.receivedCents === 0;

  const editarId = sp.editar?.trim() || undefined;
  const editandoReceivable = editarId ? rows.find((r) => r.id === editarId) : undefined;
  // O centro de custo do título pode estar inativo e não constar das opções.
  // Sem ele na lista, o select abriria em branco e salvar trocaria o vínculo.
  const editCentroAtual =
    editandoReceivable?.costCenterId &&
    !costCenterOptions.some((c) => c.id === editandoReceivable.costCenterId)
      ? costCenters.find((c) => c.id === editandoReceivable.costCenterId)
      : undefined;
  const editCentroOptions = editCentroAtual
    ? [
        { id: editCentroAtual.id, label: `${editCentroAtual.code} — ${editCentroAtual.name}` },
        ...costCenterOptions,
      ]
    : costCenterOptions;

  // Painel de recebimentos: só os ATIVOS do título aberto (estornados saem).
  const recebimentosId = sp.recebimentos?.trim() || undefined;
  const recebimentosDoTitulo = recebimentosId
    ? receipts
        .filter((rec) => rec.receivableId === recebimentosId && receiptIsActive(rec))
        .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate))
    : [];

  // Pop-up de estorno: só monta para recebimento ativo desta empresa.
  const estornarId = sp.estornar?.trim() || undefined;
  const estornoReceipt = estornarId
    ? receipts.find((rec) => rec.id === estornarId && receiptIsActive(rec))
    : undefined;
  const estornoReceivable = estornoReceipt
    ? (allReceivables.find((r) => r.id === estornoReceipt.receivableId) ?? undefined)
    : undefined;
  const podeEstornar = canCancel;

  // amountCents → "1234,56" (sem símbolo) para o defaultValue do MoneyInput.
  const centsToInput = (cents: number): string => (cents / 100).toFixed(2).replace(".", ",");

  // Data de quitação por título = MAIOR receivedDate dos recebimentos (o que
  // completou o valor). receivedDate JÁ é ISODate local (sem fuso a converter,
  // diferente de Payment.executedAt em Contas a Pagar). Só os títulos da página.
  const receivedAtByReceivable = new Map<string, ISODate>();
  const pageIds = new Set(rows.map((r) => r.id));
  for (const rec of receipts) {
    // Recebimento estornado não conta para a data de quitação.
    if (!receiptIsActive(rec)) continue;
    if (!pageIds.has(rec.receivableId)) continue;
    const prev = receivedAtByReceivable.get(rec.receivableId);
    if (!prev || rec.receivedDate > prev) {
      receivedAtByReceivable.set(rec.receivableId, rec.receivedDate);
    }
  }

  // Clientes ativos ordenados (pt-BR): reaproveitados no select do filtro E no
  // form de novo título (que exige cliente).
  const filterCustomers = customers
    .filter((c) => c.active)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  // Anos que realmente existem nos títulos (do menor ao maior dueDate).
  const anos = [...new Set(allReceivables.map((rv) => Number(rv.dueDate.slice(0, 4))))].sort(
    (a, b) => a - b
  );

  // Estado dos filtros para preservar seleção na UI e propagar na paginação.
  const anyFilterActive =
    Boolean(customerId) || Boolean(dueFrom) || Boolean(dueTo) || Boolean(anoNum) || Boolean(mesNum);
  const extraQuery: Record<string, string | undefined> = {
    status: filter === "todos" ? undefined : filter,
    ano: anoNum ? String(anoNum) : undefined,
    mes: mesNum ? String(mesNum) : undefined,
    cliente: customerId,
    de: deIso,
    ate: ateIso,
  };

  return (
    <div>
      <PageHeader
        title="Contas a receber"
        subtitle="Títulos de clientes, vencimentos, atrasos e registro de recebimentos."
      />
      <Flash ok={ok} erro={erro} />

      {/* Barra de ações da listagem. Os links levam os filtros ativos na URL,
          então o arquivo gerado corresponde ao recorte que está na tela. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link
          href="/contas-a-receber/importar"
          title="Importar títulos a partir de um arquivo CSV"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
        >
          <IconeImportar />
          Importar
        </Link>

        {/* <details> em vez de menu com JavaScript: a página segue Server
            Component e o dropdown funciona sem hidratação. */}
        <details className="relative">
          <summary
            title="Exportar todos os títulos filtrados (todas as páginas)"
            className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
          >
            <IconeExportar />
            Exportar
          </summary>
          <div className="absolute left-0 z-10 mt-1 min-w-44 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1 shadow-lg">
            <a
              href={`/contas-a-receber/export?format=csv${queryFiltros}`}
              className="block rounded px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
            >
              CSV (Excel)
            </a>
            <a
              href={`/contas-a-receber/export?format=pdf${queryFiltros}`}
              className="block rounded px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
            >
              PDF (paisagem)
            </a>
          </div>
        </details>

        <Link
          href={`/contas-a-receber/imprimir?x=1${queryFiltros}`}
          title="Abrir a visão de impressão dos títulos filtrados"
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--surface-2)]"
        >
          <IconeImprimir />
          Imprimir
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {SITUACAO_FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "todos" ? "/contas-a-receber" : `/contas-a-receber?status=${f.value}`}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              filter === f.value
                ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                : "border-[var(--line)] bg-white text-[var(--ink)] hover:bg-slate-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <Card className="mb-6" title="Filtros">
        <form method="get" action="/contas-a-receber" className="grid gap-4 md:grid-cols-3">
          {/* Status atual sobrevive ao submit do filtro. */}
          {filter !== "todos" ? <input type="hidden" name="status" value={filter} /> : null}
          <Field label="Ano">
            <select name="ano" defaultValue={anoNum ? String(anoNum) : ""} className={inputClass}>
              <option value="">Todos</option>
              {anos.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mês">
            <select name="mes" defaultValue={mesNum ? String(mesNum) : ""} className={inputClass}>
              <option value="">Todos</option>
              {MESES.map((nome, i) => (
                <option key={nome} value={i + 1}>
                  {nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cliente">
            <select name="cliente" defaultValue={customerId ?? ""} className={inputClass}>
              <option value="">Todos os clientes</option>
              {filterCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="De (vencimento)">
            <input type="date" name="de" defaultValue={deIso ?? ""} className={inputClass} />
          </Field>
          <Field label="Até (vencimento)">
            <input type="date" name="ate" defaultValue={ateIso ?? ""} className={inputClass} />
          </Field>
          <div className="flex items-end gap-2">
            <Button>Filtrar</Button>
            <Link
              href="/contas-a-receber"
              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-slate-50"
            >
              Limpar filtros
            </Link>
          </div>
        </form>
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          Todos os filtros incidem sobre o <strong>vencimento</strong>. Se preencher “De/Até”, o
          Ano e o Mês são ignorados.
        </p>
      </Card>

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState
            message={
              anyFilterActive || filter !== "todos"
                ? "Nenhum título corresponde aos filtros selecionados."
                : "Nenhum título cadastrado."
            }
          />
        ) : (
          <Table
            headers={["Cliente", "Descrição", "Parc.", "Vencimento", "Valor", "Recebido", "C. Custo", "Status", "Receber", "Cobrança", "Ações"]}
            align={["l", "l", "l", "l", "r", "r", "l", "l", "l", "l", "l"]}
          >
            {rows.map((r) => {
              const overdue = r.dueDate < today && RECEIVABLE_OPEN.includes(r.status);
              const remaining = receivableRemainingCents(r);
              // Situação DERIVADA (não persistida) para o badge. receivedAt vem do
              // recebimento que quitou o título (Map montado acima).
              const situacao = deriveReceivableSituation(r, today, receivedAtByReceivable.get(r.id));
              const situacaoLabel =
                situacao === "Atrasado" && hasPartialReceipt(r) ? "Atrasado (parcial)" : situacao;
              // Recebimento em erro nesta linha: reidrata com o que foi digitado.
              const rcErro = rcErroId === r.id;
              // Cancelável na UI = status open, sem recebimento, NÃO de nota fiscal,
              // e com permissão. A validação real (idempotência etc.) fica na skill.
              const cancelable =
                canCancel && r.status === "open" && r.receivedCents === 0 && !r.invoiceId;
              const excluding = excluir === r.id;
              return (
                <Fragment key={r.id}>
                <tr>
                  {/* Mesmo padrão de /contas-a-pagar: Cliente (w-full max-w-0) absorve a
                      largura livre e trunca; !px-2/!py-1/text-xs compactam a linha. */}
                  <Td className="w-full max-w-0 truncate whitespace-nowrap !px-2 !py-1 text-xs">
                    <span title={customerName.get(r.customerId) ?? r.customerId}>
                      {customerName.get(r.customerId) ?? r.customerId}
                    </span>
                  </Td>
                  <Td className="max-w-[240px] truncate whitespace-nowrap !px-2 !py-1 text-xs">
                    <span title={r.description}>{r.description}</span>
                  </Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">{`${r.installmentNumber}/${r.installmentCount}`}</Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    <span className={overdue ? "font-semibold text-[var(--crit)]" : ""}>
                      {formatBR(r.dueDate)}
                      {overdue ? " (vencido)" : ""}
                    </span>
                  </Td>
                  <Td right className="whitespace-nowrap !px-2 !py-1 text-xs">{formatBRL(r.amountCents)}</Td>
                  <Td right className="whitespace-nowrap !px-2 !py-1 text-xs">{formatBRL(r.receivedCents)}</Td>
                  {/* Centro de custo: exibe o CÓDIGO (ou "—" quando não vinculado). */}
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {r.costCenterId ? (costCenterCode.get(r.costCenterId) ?? r.costCenterId) : "—"}
                  </Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    <Badge tone={SITUACAO_TONE[situacao]}>{situacaoLabel}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {RECEIVABLE_OPEN.includes(r.status) ? (
                      <form action={registerReceiptAction} className="flex flex-nowrap items-center gap-1">
                        <input type="hidden" name="receivableId" value={r.id} />
                        {/* Em erro, reidrata com rc_*; senão, valor = saldo restante e hoje. */}
                        <MoneyInput
                          name="amount"
                          required
                          defaultValue={rcErro ? (sp.rc_valor ?? "") : (remaining / 100).toFixed(2).replace(".", ",")}
                          className={`${inputClass} !w-24 shrink-0 !px-2 !text-xs`}
                          title="Valor recebido (R$)"
                        />
                        <input
                          type="date"
                          name="receivedDate"
                          required
                          defaultValue={rcErro ? (sp.rc_data ?? today) : today}
                          className={`${inputClass} !w-32 shrink-0 !px-2 !text-xs`}
                        />
                        <select
                          name="method"
                          required
                          defaultValue={rcErro ? (sp.rc_metodo ?? "pix") : "pix"}
                          className={`${inputClass} !w-24 shrink-0 !px-2 !text-xs`}
                        >
                          <option value="pix">Pix</option>
                          <option value="boleto">Boleto</option>
                          <option value="card">Cartão</option>
                          <option value="transfer">Transferência</option>
                          <option value="cash">Dinheiro</option>
                        </select>
                        <select
                          name="bankAccountId"
                          defaultValue={rcErro ? (sp.rc_conta ?? "") : ""}
                          className={`${inputClass} !w-28 shrink-0 !px-2 !text-xs`}
                        >
                          <option value="">Sem conta</option>
                          {activeAccounts.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <span className="shrink-0 [&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button variant="secondary">Registrar</Button>
                        </span>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {RECEIVABLE_OPEN.includes(r.status) ? (
                      <form action={issueChargeAction} className="flex flex-nowrap items-center gap-1">
                        <input type="hidden" name="receivableId" value={r.id} />
                        <select
                          name="kind"
                          required
                          className={`${inputClass} !w-20 shrink-0 !px-2 !text-xs`}
                          title="Tipo de cobrança"
                        >
                          <option value="pix">Pix</option>
                          <option value="boleto">Boleto</option>
                        </select>
                        <span className="shrink-0 [&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button variant="secondary">Gerar</Button>
                        </span>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                  {/* Ações: Editar (✎), Recebimentos (💰) e Excluir (🗑) na MESMA
                      coluna, ícones compactos. Cada um abre um bloco inline via
                      GET; nenhum age por si. "—" quando nada se aplica. */}
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {podeEditar && isEditable(r) ? (
                      <form method="get" action="/contas-a-receber" className="inline">
                        {Object.entries(extraQuery).map(([k, v]) =>
                          v ? <input key={k} type="hidden" name={k} value={v} /> : null
                        )}
                        {sp.p ? <input type="hidden" name="p" value={sp.p} /> : null}
                        <input type="hidden" name="editar" value={editarId === r.id ? "" : r.id} />
                        <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button variant="warn" type="submit">
                            {editarId === r.id ? "Fechar" : "✎"}
                          </Button>
                        </span>
                      </form>
                    ) : null}
                    {r.receivedCents > 0 ? (
                      <form method="get" action="/contas-a-receber" className="ml-1 inline">
                        {Object.entries(extraQuery).map(([k, v]) =>
                          v ? <input key={k} type="hidden" name={k} value={v} /> : null
                        )}
                        {sp.p ? <input type="hidden" name="p" value={sp.p} /> : null}
                        <input
                          type="hidden"
                          name="recebimentos"
                          value={recebimentosId === r.id ? "" : r.id}
                        />
                        <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button variant="secondary" type="submit">
                            {recebimentosId === r.id ? "Fechar" : "💰"}
                          </Button>
                        </span>
                      </form>
                    ) : null}
                    {cancelable ? (
                      <form method="get" action="/contas-a-receber" className="ml-1 inline">
                        {Object.entries(extraQuery).map(([k, v]) =>
                          v ? <input key={k} type="hidden" name={k} value={v} /> : null
                        )}
                        {sp.p ? <input type="hidden" name="p" value={sp.p} /> : null}
                        <input type="hidden" name="excluir" value={excluding ? "" : r.id} />
                        <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button variant="danger" type="submit">
                            {excluding ? "Fechar" : "🗑"}
                          </Button>
                        </span>
                      </form>
                    ) : null}
                    {!(podeEditar && isEditable(r)) && r.receivedCents === 0 && !cancelable ? (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    ) : null}
                  </Td>
                </tr>
                {editandoReceivable && editarId === r.id ? (
                  <tr>
                    {/* <td> cru por causa do colSpan, que o Td não expõe. */}
                    <td className="px-2 py-2 align-middle" colSpan={11}>
                      <EditReceivableForm
                        receivable={{
                          id: r.id,
                          customerName: customerName.get(r.customerId) ?? r.customerId,
                          description: r.description,
                          amount: centsToInput(r.amountCents),
                          issueDate: r.issueDate,
                          dueDate: r.dueDate,
                          categoryId: r.categoryId ?? "",
                          costCenterId: r.costCenterId ?? "",
                          notes: r.notes ?? "",
                          installmentNumber: r.installmentNumber,
                          installmentCount: r.installmentCount,
                          fromInvoice: Boolean(r.invoiceId),
                        }}
                        categorias={incomeCategories.map((c) => ({ id: c.id, name: c.name }))}
                        centros={editCentroOptions}
                        prefill={{
                          description: sp.f_descricao,
                          amount: sp.f_valor,
                          issueDate: sp.f_emissao,
                          dueDate: sp.f_vencimento,
                          categoryId: sp.f_categoria,
                          costCenterId: sp.f_centrocusto,
                          notes: sp.f_notas,
                        }}
                        cancelHref="/contas-a-receber"
                      />
                    </td>
                  </tr>
                ) : null}
                {recebimentosId === r.id ? (
                  <tr>
                    <td className="px-2 py-2 align-middle" colSpan={11}>
                      {/* Recebimentos do título: um lugar só para corrigir a data
                          (que decide Recebido / no Vencimento / em Atraso) e para
                          estornar. Estornados não aparecem — saíram das contas. */}
                      <div className="rounded-lg border border-[var(--line)] bg-slate-50 p-3">
                        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
                          Recebimentos deste título
                        </p>
                        {recebimentosDoTitulo.length === 0 ? (
                          <p className="text-sm text-[var(--ink-muted)]">
                            Nenhum recebimento ativo (os estornados saem desta lista).
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {recebimentosDoTitulo.map((rec) => (
                              <div
                                key={rec.id}
                                className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-[var(--line)] bg-white p-2"
                              >
                                <p className="text-sm">
                                  <strong className="tabular">{formatBRL(rec.amountCents)}</strong>{" "}
                                  · {rec.method} ·{" "}
                                  <span className="text-[var(--ink-muted)]">
                                    registrado em {formatBR(rec.receivedDate)}
                                  </span>
                                </p>
                                <div className="flex flex-wrap items-end gap-2">
                                  <form
                                    action={adjustReceiptDateAction}
                                    className="flex items-end gap-2"
                                  >
                                    <input type="hidden" name="receiptId" value={rec.id} />
                                    <input type="hidden" name="receivableId" value={r.id} />
                                    <Field label="Data do recebimento">
                                      <input
                                        type="date"
                                        name="receivedDate"
                                        required
                                        min={r.issueDate}
                                        max={today}
                                        defaultValue={rec.receivedDate}
                                        className={`${inputClass} md:w-44`}
                                      />
                                    </Field>
                                    <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                      <Button variant="warn" type="submit">
                                        Salvar data
                                      </Button>
                                    </span>
                                  </form>
                                  {podeEstornar ? (
                                    <form method="get" action="/contas-a-receber" className="inline">
                                      <input type="hidden" name="estornar" value={rec.id} />
                                      <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                                        <Button variant="danger" type="submit">
                                          Estornar
                                        </Button>
                                      </span>
                                    </form>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="mt-2 text-xs text-[var(--ink-muted)]">
                          Corrigir a data reclassifica a situação do título — Recebido (antes
                          do vencimento), Recebido no Vencimento (no dia) ou Recebido em
                          Atraso (depois) — e o realizado do Orçamento acompanha, podendo
                          mudar de mês.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {excluding && cancelable ? (
                  <tr>
                    {/* Form de cancelamento inline. <td> cru p/ colSpan (o Td compartilhado
                        não o expõe). Motivo obrigatório; em erro reabre com ?f_motivo. */}
                    <td className="px-2 py-2 align-middle" colSpan={11}>
                      <form
                        action={cancelReceivableAction}
                        className="rounded-lg border border-red-200 bg-red-50 p-3"
                      >
                        <input type="hidden" name="receivableId" value={r.id} />
                        <p className="mb-2 text-sm text-[var(--crit)]">
                          O título será cancelado e permanecerá no histórico para auditoria.
                          Mensagens de cobrança pendentes vinculadas também serão canceladas.
                          Cobranças já emitidas (Pix/boleto mock) não são revogadas.
                        </p>
                        <Field label="Motivo do cancelamento">
                          <input
                            name="reason"
                            required
                            defaultValue={sp.f_motivo ?? ""}
                            className={inputClass}
                            placeholder="Ex.: venda cancelada pelo cliente"
                          />
                        </Field>
                        <div className="mt-3 flex items-center gap-2">
                          <Button variant="danger" type="submit">
                            Confirmar cancelamento
                          </Button>
                          <Link
                            href="/contas-a-receber"
                            className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
                          >
                            Voltar
                          </Link>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              );
            })}
          </Table>
        )}
        <Pager page={page} basePath="/contas-a-receber" extraQuery={extraQuery} />
      </Card>

      <Card title="Novo título">
        {filterCustomers.length === 0 ? (
          // Cliente é obrigatório e não há nenhum ativo: em vez de um form
          // impossível de enviar, aponta para o cadastro de clientes.
          <p className="text-sm text-[var(--ink-muted)]">
            Nenhum cliente ativo.{" "}
            <a href="/cadastros/clientes" className="text-[var(--brand)] underline">
              Cadastrar cliente
            </a>{" "}
            antes de criar títulos a receber.
          </p>
        ) : (
        <>
        {/* Em falha de validação, os campos voltam preenchidos (nt_* → defaultValue),
            inclusive o campo errado; no erro de datas, Emissão/Vencimento ganham
            borda de atenção e o Vencimento recebe autoFocus. Sucesso não propaga. */}
        <form action={createReceivableAction} className="grid gap-4 md:grid-cols-3">
          <Field label="Cliente">
            {/* Autocompletar nativo (mesma abordagem do Fornecedor em /contas-a-pagar):
                <input list> filtra por digitação (substring, acha o nome no meio).
                Submete o NOME; a action resolve nome → id (nomes são únicos por empresa). */}
            <input
              list="clientes"
              name="customerName"
              required
              defaultValue={sp.nt_cliente ?? ""}
              className={inputClass}
              placeholder="Digite as primeiras letras..."
              autoComplete="off"
            />
            <datalist id="clientes">
              {filterCustomers.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Descrição">
            <input
              name="description"
              required
              defaultValue={sp.nt_descricao ?? ""}
              className={inputClass}
              placeholder="Ex.: Venda pedido 987"
            />
          </Field>
          <Field label="Valor total (R$)">
            <MoneyInput name="amount" required defaultValue={sp.nt_valor ?? ""} className={inputClass} placeholder="1.234,56" />
          </Field>
          <Field label="Emissão">
            <input
              type="date"
              name="issueDate"
              required
              defaultValue={sp.nt_emissao ?? today}
              className={ntDateFieldClass}
            />
          </Field>
          <Field label="Vencimento">
            <input
              type="date"
              name="dueDate"
              required
              defaultValue={sp.nt_vencimento ?? ""}
              className={ntDateFieldClass}
              autoFocus={ntDateError}
            />
          </Field>
          <Field label="Parcelas">
            <input
              type="number"
              name="installmentCount"
              min={1}
              max={120}
              defaultValue={sp.nt_parcelas ?? "1"}
              className={inputClass}
            />
          </Field>
          <Field label="Categoria (opcional)">
            <select name="categoryId" className={inputClass} defaultValue={sp.nt_categoria ?? ""}>
              <option value="">Sugerir automaticamente</option>
              {incomeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {/* Centro de custo OPCIONAL (.optional() na skill) — não pode ser required.
              value é o id; exibição "CÓDIGO — Nome". Lista só os ativos. */}
          <Field label="Centro de Custo (opcional)">
            <select name="costCenterId" className={inputClass} defaultValue={sp.nt_centrocusto ?? ""}>
              <option value="">— sem centro de custo —</option>
              {costCenterOptions.map((cc) => (
                <option key={cc.id} value={cc.id}>
                  {cc.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Método previsto (opcional)">
            <select name="method" className={inputClass} defaultValue={sp.nt_metodo ?? ""}>
              <option value="">Não informado</option>
              <option value="pix">Pix</option>
              <option value="boleto">Boleto</option>
              <option value="card">Cartão</option>
              <option value="transfer">Transferência</option>
              <option value="cash">Dinheiro</option>
            </select>
          </Field>
          {/* Observação: a entidade e a skill já aceitavam `notes`; faltava a
              caixa. Ocupa a linha por ser mais longa que os demais campos. */}
          <div className="md:col-span-3">
            <Field label="Observação (opcional)">
              <textarea
                name="notes"
                rows={2}
                defaultValue={sp.nt_observacao ?? ""}
                className={inputClass}
                placeholder="Anotações sobre este título."
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button>Criar título</Button>
          </div>
        </form>
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          Criação e baixa são registradas com auditoria automática pela skill de contas a receber
          (idempotente: reenviar o mesmo formulário não duplica títulos).
        </p>
        </>
        )}
      </Card>

      {/* POP-UP de confirmação do estorno. Sobreposição renderizada no servidor
          (sem estado de cliente), aberta por ?estornar=<receiptId> e fechada
          voltando para a tela. Motivo obrigatório — é o que explica o estorno
          na trilha de auditoria. */}
      {estornoReceipt && estornoReceivable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-lg p-4 shadow-xl">
            <h2 className="text-base font-semibold text-[var(--crit)]">Estornar recebimento</h2>
            <p className="mt-2 text-sm">
              O recebimento de{" "}
              <strong className="tabular">{formatBRL(estornoReceipt.amountCents)}</strong> de{" "}
              {customerName.get(estornoReceivable.customerId) ?? estornoReceivable.customerId} será
              estornado.
            </p>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              {estornoReceivable.description} · recebido em {formatBR(estornoReceipt.receivedDate)}
            </p>
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              O saldo <strong>volta para o título</strong>, que retorna à fila de cobrança, e o
              lançamento contábil é estornado. Nada é apagado: o recebimento fica no histórico
              como cancelado e sai das contas (orçamento, DSO, contabilidade e relatórios).
            </p>
            <form action={reverseReceiptAction} className="mt-3">
              <input type="hidden" name="receiptId" value={estornoReceipt.id} />
              <Field label="Motivo do estorno">
                <input
                  name="reason"
                  required
                  autoFocus
                  defaultValue={sp.f_motivo_estorno ?? ""}
                  className={inputClass}
                  placeholder="Ex.: baixa lançada no título errado"
                />
              </Field>
              <div className="mt-3 flex items-center gap-2">
                <Button variant="danger" type="submit">
                  Confirmar estorno
                </Button>
                <Link
                  href="/contas-a-receber"
                  className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                >
                  Voltar
                </Link>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
