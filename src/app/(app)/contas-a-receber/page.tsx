import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";
import { endOfMonth, isISODate, startOfMonth, todayInTz, type ISODate } from "@/core/dates";
import type { ReceivableStatus } from "@/core/entities";
import { receivableRemainingCents } from "@/core/money";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { createReceivableAction, issueChargeAction, registerReceiptAction } from "./actions";
import { MoneyInput } from "@/components/money-input";

const STATUS_FILTERS: Array<{ value: ReceivableStatus | "todos"; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "open", label: "Em aberto" },
  { value: "partially_received", label: "Recebidos parcial" },
  { value: "received", label: "Recebidos" },
  { value: "canceled", label: "Cancelados" },
];

const RECEIVABLE_OPEN: ReceivableStatus[] = ["open", "partially_received"];

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
    nt_metodo?: string;
  }>;
}) {
  const sp = await searchParams;
  const { status, p, ok, erro, ano, mes, cliente, de, ate } = sp;
  // Erro de datas liga o destaque de Emissão/Vencimento no form de novo título.
  const ntDateError = sp.nt_erro === "data";
  const ntDateFieldClass = ntDateError
    ? `${inputClass} border-[var(--crit)] focus:border-[var(--crit)]`
    : inputClass;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const today = todayInTz(clock.now(), session.config.timezone);

  const filter = STATUS_FILTERS.some((f) => f.value === status) ? status : "todos";

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

  let dueFrom: ISODate | undefined;
  let dueTo: ISODate | undefined;
  if (deIso || ateIso) {
    dueFrom = deIso;
    dueTo = ateIso;
  } else if (anoNum) {
    if (mesNum) {
      const monthKey = `${anoNum}-${String(mesNum).padStart(2, "0")}`;
      dueFrom = startOfMonth(monthKey);
      dueTo = endOfMonth(monthKey); // último dia correto (fev/30 dias) via helper
    } else {
      dueFrom = `${anoNum}-01-01`;
      dueTo = `${anoNum}-12-31`;
    }
  }

  const customerId = cliente || undefined;

  const [page, customers, categories, bankAccounts, allReceivables] = await Promise.all([
    // Listagem paginada no repositório (volumetria) — ordem: vencimento asc.
    // Filtros de status/cliente/vencimento aplicados no banco.
    repos.receivables.listPage(companyId, {
      offset: pageOffset(p),
      limit: PAGE_SIZE,
      statuses: filter === "todos" ? undefined : [filter as ReceivableStatus],
      customerId,
      dueFrom,
      dueTo,
    }),
    repos.customers.listAll(companyId),
    repos.categories.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
    // Só para derivar os anos existentes nos títulos (lista de anos é pequena).
    repos.receivables.listAll(companyId),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const incomeCategories = categories.filter((c) => c.kind === "income" && c.active);
  const activeAccounts = bankAccounts.filter((b) => b.active);
  const rows = page.items;

  // Clientes ativos ordenados (pt-BR) para o select do filtro.
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
        {STATUS_FILTERS.map((f) => (
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
            headers={["Cliente", "Descrição", "Parcela", "Vencimento", "Valor", "Recebido", "Status", "Registrar recebimento", "Cobrança (mock)"]}
            align={["l", "l", "l", "l", "r", "r", "l", "l", "l"]}
          >
            {rows.map((r) => {
              const overdue = r.dueDate < today && RECEIVABLE_OPEN.includes(r.status);
              const remaining = receivableRemainingCents(r);
              return (
                <tr key={r.id}>
                  <Td>{customerName.get(r.customerId) ?? r.customerId}</Td>
                  <Td>{r.description}</Td>
                  <Td>{`${r.installmentNumber}/${r.installmentCount}`}</Td>
                  <Td>
                    <span className={overdue ? "font-semibold text-[var(--crit)]" : ""}>
                      {formatBR(r.dueDate)}
                      {overdue ? " (vencido)" : ""}
                    </span>
                  </Td>
                  <Td right>{formatBRL(r.amountCents)}</Td>
                  <Td right>{formatBRL(r.receivedCents)}</Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                  </Td>
                  <Td>
                    {RECEIVABLE_OPEN.includes(r.status) ? (
                      <form action={registerReceiptAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="receivableId" value={r.id} />
                        <MoneyInput
                          name="amount"
                          required
                          defaultValue={(remaining / 100).toFixed(2).replace(".", ",")}
                          className={`${inputClass} w-24`}
                          title="Valor recebido (R$)"
                        />
                        <input
                          type="date"
                          name="receivedDate"
                          required
                          defaultValue={today}
                          className={`${inputClass} w-36`}
                        />
                        <select name="method" required className={`${inputClass} w-28`}>
                          <option value="pix">Pix</option>
                          <option value="boleto">Boleto</option>
                          <option value="card">Cartão</option>
                          <option value="transfer">Transferência</option>
                          <option value="cash">Dinheiro</option>
                        </select>
                        <select name="bankAccountId" className={`${inputClass} w-36`}>
                          <option value="">Sem conta</option>
                          {activeAccounts.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <Button variant="secondary">Registrar</Button>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                  <Td>
                    {RECEIVABLE_OPEN.includes(r.status) ? (
                      <form action={issueChargeAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="receivableId" value={r.id} />
                        <select name="kind" required className={`${inputClass} w-24`} title="Tipo de cobrança">
                          <option value="pix">Pix</option>
                          <option value="boleto">Boleto</option>
                        </select>
                        <Button variant="secondary">Gerar</Button>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={page} basePath="/contas-a-receber" extraQuery={extraQuery} />
      </Card>

      <Card title="Novo título">
        {/* Em falha de validação, os campos voltam preenchidos (nt_* → defaultValue),
            inclusive o campo errado; no erro de datas, Emissão/Vencimento ganham
            borda de atenção e o Vencimento recebe autoFocus. Sucesso não propaga. */}
        <form action={createReceivableAction} className="grid gap-4 md:grid-cols-3">
          <Field label="Cliente">
            <select name="customerId" required className={inputClass} defaultValue={sp.nt_cliente ?? ""}>
              <option value="">Selecione…</option>
              {customers
                .filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
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
      </Card>
    </div>
  );
}
