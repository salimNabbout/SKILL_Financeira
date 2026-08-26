import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
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
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import {
  cancelReceivableAction,
  createReceivableAction,
  issueChargeAction,
  registerReceiptAction,
} from "./actions";
import { MoneyInput } from "@/components/money-input";

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
  Recebido: "ok",
  "Recebido em Atraso": "ok", // ok, mas o texto do badge sinaliza o atraso
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
    // Reexibição do form de RECEBIMENTO (inline por linha) após falha (rc_).
    rc_id?: string;
    rc_valor?: string;
    rc_data?: string;
    rc_metodo?: string;
    rc_conta?: string;
    // Cancelamento inline por linha (?excluir=<id>) e motivo preservado em erro.
    excluir?: string;
    f_motivo?: string;
  }>;
}) {
  const sp = await searchParams;
  const { status, p, ok, erro, ano, mes, cliente, de, ate } = sp;
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
  // Centros ATIVOS, "CÓDIGO — Nome", ordenados por código (pt-BR); value = id.
  // CostCenter não tem `scope` — listamos todos os ativos (ver relatório).
  const costCenterOptions = costCenters
    .filter((c) => c.active)
    .sort((a, b) => a.code.localeCompare(b.code, "pt-BR"))
    .map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }));

  // Data de quitação por título = MAIOR receivedDate dos recebimentos (o que
  // completou o valor). receivedDate JÁ é ISODate local (sem fuso a converter,
  // diferente de Payment.executedAt em Contas a Pagar). Só os títulos da página.
  const receivedAtByReceivable = new Map<string, ISODate>();
  const pageIds = new Set(rows.map((r) => r.id));
  for (const rec of receipts) {
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
                  {/* Ações: Excluir (🗑) agrupado nesta coluna (Editar virá quando
                      update_receivable existir). Abre o form inline via GET (?excluir=id).
                      Só quando cancelável; senão "—". */}
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {cancelable ? (
                      <form method="get" action="/contas-a-receber" className="inline">
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
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                </tr>
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
    </div>
  );
}
