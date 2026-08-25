import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";
import { endOfMonth, isISODate, startOfMonth, todayInTz, type ISODate } from "@/core/dates";
import type { PayableStatus } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { cancelPayableAction, schedulePaymentAction, updatePayableAction } from "./actions";
import { NewPayableForm, type SupplierOption } from "./_lib/new-payable-form";

const STATUS_FILTERS: Array<{ value: PayableStatus | "todos"; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "open", label: "Em aberto" },
  { value: "scheduled", label: "Agendados" },
  { value: "partially_paid", label: "Pagos parcial" },
  { value: "paid", label: "Pagos" },
  { value: "canceled", label: "Cancelados" },
];

const SCHEDULABLE: PayableStatus[] = ["open", "partially_paid"];
// Status que a skill cancel_payable aceita (index.ts): só open e scheduled.
// A UI é conveniência — a validação real continua na skill.
const CANCELABLE: PayableStatus[] = ["open", "scheduled"];

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export default async function ContasAPagarPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    p?: string;
    ok?: string;
    erro?: string;
    ano?: string;
    mes?: string;
    fornecedor?: string;
    de?: string;
    ate?: string;
    editar?: string;
    f_descricao?: string;
    f_emissao?: string;
    f_vencimento?: string;
    f_valor?: string;
    f_categoria?: string;
    f_custo?: string;
    f_notas?: string;
    excluir?: string;
    f_motivo?: string;
    // Reexibição do formulário "Novo título" após falha de validação (prefixo nt_).
    nt_erro?: string;
    nt_fornecedor?: string;
    nt_descricao?: string;
    nt_valor?: string;
    nt_emissao?: string;
    nt_vencimento?: string;
    nt_categoria?: string;
    nt_custo?: string;
    nt_tipo?: string;
    nt_parcelas?: string;
    nt_frequencia?: string;
    nt_ocorrencias?: string;
  }>;
}) {
  const sp = await searchParams;
  const { status, p, ok, erro, ano, mes, fornecedor, de, ate } = sp;
  const editar = sp.editar?.trim() || undefined;
  const excluir = sp.excluir?.trim() || undefined;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const canCancel = hasPermission(session.membership.role, "payable.cancel");
  const today = todayInTz(clock.now(), session.config.timezone);

  const filter = STATUS_FILTERS.some((f) => f.value === status) ? status : "todos";

  // Precedência: Período (de/ate) tem prioridade sobre Ano/Mês (regra no servidor).
  const deIso = de && isISODate(de) ? de : undefined;
  const ateIso = ate && isISODate(ate) ? ate : undefined;
  if (deIso && ateIso && deIso > ateIso) {
    redirect(`/contas-a-pagar?erro=${encodeURIComponent("Data inicial maior que a final.")}`);
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

  const supplierId = fornecedor || undefined;

  const [page, suppliers, supplierCategories, bankAccounts, allPayables] = await Promise.all([
    // Listagem paginada no repositório (volumetria) — ordem: vencimento asc.
    // Filtros de status/fornecedor/vencimento aplicados no banco.
    repos.payables.listPage(companyId, {
      offset: pageOffset(p),
      limit: PAGE_SIZE,
      statuses: filter === "todos" ? undefined : [filter as PayableStatus],
      supplierId,
      dueFrom,
      dueTo,
    }),
    repos.suppliers.listAll(companyId),
    repos.supplierCategories.listAll(companyId),
    repos.bankAccounts.listAll(companyId),
    // Só para derivar os anos existentes nos títulos (lista de anos é pequena).
    repos.payables.listAll(companyId),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const activeAccounts = bankAccounts.filter((b) => b.active);
  const rows = page.items;

  const supplierOptions: SupplierOption[] = suppliers
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name }));
  const categoryOptions = [...supplierCategories]
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Fornecedores ativos ordenados (pt-BR) para o select do filtro.
  const filterSuppliers = suppliers
    .filter((s) => s.active)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  // Anos que realmente existem nos títulos (do menor ao maior dueDate).
  const anos = [...new Set(allPayables.map((pv) => Number(pv.dueDate.slice(0, 4))))].sort(
    (a, b) => a - b
  );

  // Estado dos filtros para preservar seleção na UI e propagar na paginação.
  const anyFilterActive =
    Boolean(supplierId) || Boolean(dueFrom) || Boolean(dueTo) || Boolean(anoNum) || Boolean(mesNum);
  const extraQuery: Record<string, string | undefined> = {
    status: filter === "todos" ? undefined : filter,
    ano: anoNum ? String(anoNum) : undefined,
    mes: mesNum ? String(mesNum) : undefined,
    fornecedor: supplierId,
    de: deIso,
    ate: ateIso,
  };

  // Editável = título com potencial de edição pela regra da Etapa 0: não
  // encerrado (paid/canceled) e sem movimento financeiro (paidCents > 0).
  // A trava fina do VALOR (pagamento pendente) é validada na skill; aqui só
  // decidimos exibir/ocultar o botão e avisar quando o valor não pode mudar.
  const isEditable = (pv: (typeof rows)[number]): boolean =>
    pv.status !== "paid" && pv.status !== "canceled" && pv.paidCents === 0;

  // Cancelável na UI = mesmos status que a skill aceita (open/scheduled) E o
  // usuário tem a permissão payable.cancel. A validação real continua na skill.
  const isCancelable = (pv: (typeof rows)[number]): boolean =>
    canCancel && CANCELABLE.includes(pv.status);

  // Link para abrir/fechar o formulário inline de edição, preservando os
  // filtros e a página atuais (searchParam ?editar=<id>).
  const editHref = (id: string | null): string => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(extraQuery)) if (v) qs.set(k, v);
    if (p) qs.set("p", p);
    if (id) qs.set("editar", id);
    const s = qs.toString();
    return s ? `/contas-a-pagar?${s}` : "/contas-a-pagar";
  };

  // amountCents → "1234,56" (sem símbolo) para o defaultValue do input de valor.
  const centsToInput = (cents: number): string =>
    (cents / 100).toFixed(2).replace(".", ",");

  // Reexibição do formulário "Novo título" após falha de validação: reidrata os
  // campos com o que foi digitado (nt_*). Ausente em caso de sucesso (nada é
  // propagado). `dateError` liga o destaque de Emissão/Vencimento.
  const hasPrefill =
    Boolean(sp.nt_fornecedor) ||
    Boolean(sp.nt_descricao) ||
    Boolean(sp.nt_valor) ||
    Boolean(sp.nt_vencimento) ||
    Boolean(sp.nt_tipo);
  const newPayablePrefill = hasPrefill
    ? {
        supplierId: sp.nt_fornecedor,
        description: sp.nt_descricao,
        amount: sp.nt_valor,
        issueDate: sp.nt_emissao,
        dueDate: sp.nt_vencimento,
        supplierCategory: sp.nt_categoria,
        costClassification: sp.nt_custo,
        tipo: sp.nt_tipo === "recorrente" ? ("recorrente" as const) : ("parcelado" as const),
        installmentCount: sp.nt_parcelas,
        recurrenceFrequency: sp.nt_frequencia,
        recurrenceOccurrences: sp.nt_ocorrencias,
      }
    : undefined;
  const newPayableDateError = sp.nt_erro === "data";

  return (
    <div>
      <PageHeader
        title="Contas a pagar"
        subtitle="Títulos de fornecedores, vencimentos e agendamento de pagamentos (sempre com aprovação humana)."
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6" title="Novo título">
        <NewPayableForm
          suppliers={supplierOptions}
          categories={categoryOptions}
          today={today}
          prefill={newPayablePrefill}
          dateError={newPayableDateError}
        />
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          O título passa pelo fluxo de entrada de nota (validação de duplicidade, projeção de caixa e
          impacto orçamentário). Valores em reais são convertidos para centavos.
        </p>
      </Card>

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "todos" ? "/contas-a-pagar" : `/contas-a-pagar?status=${f.value}`}
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
        <form method="get" action="/contas-a-pagar" className="grid gap-4 md:grid-cols-3">
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
          <Field label="Fornecedor">
            <select name="fornecedor" defaultValue={supplierId ?? ""} className={inputClass}>
              <option value="">Todos os fornecedores</option>
              {filterSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
              href="/contas-a-pagar"
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
            headers={["Fornecedor", "Descrição", "Parc.", "Vencimento", "Valor", "Pago", "Status", "Pagar", "Ações"]}
            align={["l", "l", "l", "l", "r", "r", "l", "l", "l"]}
          >
            {rows.map((p) => {
              const overdue = p.dueDate < today && p.status !== "paid" && p.status !== "canceled";
              const editing = editar === p.id;
              return (
                <Fragment key={p.id}>
                <tr>
                  {/* Densidade: !px-2 (vence px-3 do Td), text-xs e !py-1 compactam a linha.
                      truncate + nowrap + title mantêm o nome completo acessível no tooltip.
                      O "!" é necessário porque, sem ele, as classes do componente compartilhado
                      (px-3/py-2) ganhariam por ordem no CSS (Tailwind v4).
                      Fornecedor (w-full max-w-0) absorve a largura livre da página e trunca dentro
                      dela; Descrição cresce até um teto amplo. Assim a tabela ocupa a largura toda
                      sem sobrar vazio à direita, mostrando mais do nome antes de reticenciar. */}
                  <Td className="w-full max-w-0 truncate whitespace-nowrap !px-2 !py-1 text-xs">
                    <span title={supplierName.get(p.supplierId) ?? p.supplierId}>
                      {supplierName.get(p.supplierId) ?? p.supplierId}
                    </span>
                  </Td>
                  <Td className="max-w-[360px] truncate whitespace-nowrap !px-2 !py-1 text-xs">
                    <span title={p.description}>{p.description}</span>
                  </Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">{`${p.installmentNumber}/${p.installmentCount}`}</Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    <span className={overdue ? "font-semibold text-[var(--crit)]" : ""}>
                      {formatBR(p.dueDate)}
                    </span>
                  </Td>
                  <Td right className="whitespace-nowrap !px-2 !py-1 text-xs">{formatBRL(p.amountCents)}</Td>
                  <Td right className="whitespace-nowrap !px-2 !py-1 text-xs">{formatBRL(p.paidCents)}</Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    <Badge tone={statusTone(p.status)}>{statusLabel(p.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {SCHEDULABLE.includes(p.status) ? (
                      <form action={schedulePaymentAction} className="flex flex-nowrap items-center gap-1">
                        <input type="hidden" name="payableId" value={p.id} />
                        {/* !w-24/!w-32 e !text-xs vencem o w-full/text-sm do inputClass; sem "!"
                            o campo estica/mantém o corpo maior e empurra o layout. shrink-0 impede
                            o flex de encolhê-los. O input date tem piso nativo (~140px) no Chrome. */}
                        <select
                          name="bankAccountId"
                          required
                          className={`${inputClass} !w-24 shrink-0 !px-2 !text-xs`}
                        >
                          {activeAccounts.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="date"
                          name="scheduledDate"
                          required
                          defaultValue={p.dueDate >= today ? p.dueDate : today}
                          className={`${inputClass} !w-32 shrink-0 !px-2 !text-xs`}
                        />
                        {/* Button não aceita className; envolvo num span que sobrescreve o
                            padding/tamanho via seletor de filho (:only-child) sem tocar no componente. */}
                        <span className="shrink-0 [&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button variant="success">Pagar</Button>
                        </span>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                  {/* Ações: Editar (✎) e Excluir (🗑) agrupados na MESMA coluna, ícones
                      compactos para não reintroduzir rolagem horizontal (A.5). Cada botão
                      abre um form inline via GET (?editar / ?excluir). "—" quando nenhuma
                      ação é aplicável. */}
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">
                    {isEditable(p) || isCancelable(p) ? (
                      <div className="flex flex-nowrap items-center gap-1">
                        {isEditable(p) ? (
                          <form method="get" action="/contas-a-pagar" className="inline">
                            {Object.entries(extraQuery).map(([k, v]) =>
                              v ? <input key={k} type="hidden" name={k} value={v} /> : null
                            )}
                            {sp.p ? <input type="hidden" name="p" value={sp.p} /> : null}
                            <input type="hidden" name="editar" value={editar === p.id ? "" : p.id} />
                            <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                              <Button variant="warn" type="submit">
                                {editar === p.id ? "Fechar" : "✎"}
                              </Button>
                            </span>
                          </form>
                        ) : null}
                        {isCancelable(p) ? (
                          <form method="get" action="/contas-a-pagar" className="inline">
                            {Object.entries(extraQuery).map(([k, v]) =>
                              v ? <input key={k} type="hidden" name={k} value={v} /> : null
                            )}
                            {sp.p ? <input type="hidden" name="p" value={sp.p} /> : null}
                            <input type="hidden" name="excluir" value={excluir === p.id ? "" : p.id} />
                            <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                              <Button variant="danger" type="submit">
                                {excluir === p.id ? "Fechar" : "🗑"}
                              </Button>
                            </span>
                          </form>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">—</span>
                    )}
                  </Td>
                </tr>
                {editing ? (
                  <tr>
                    {/* Célula que ocupa a largura toda da tabela para o form inline.
                        Usa <td> cru (não o Td compartilhado) porque precisa de colSpan,
                        que o Td não expõe — o componente compartilhado não é alterado. */}
                    <td className="px-2 py-2 align-middle" colSpan={9}>
                      {/* Formulário de edição inline (Server Component; sem client/useState).
                          Em erro de validação, a action reabre esta linha com os campos
                          preenchidos via ?f_*= (defaultValue abaixo). */}
                      <form
                        action={updatePayableAction}
                        className="grid gap-3 rounded-lg border border-[var(--line)] bg-slate-50 p-3 md:grid-cols-3"
                      >
                        <input type="hidden" name="payableId" value={p.id} />
                        <Field label="Descrição">
                          <input
                            name="description"
                            required
                            defaultValue={sp.f_descricao ?? p.description}
                            className={inputClass}
                          />
                        </Field>
                        <Field label="Valor (R$)">
                          <input
                            name="amount"
                            required
                            defaultValue={sp.f_valor ?? centsToInput(p.amountCents)}
                            className={inputClass}
                            placeholder="1.234,56"
                          />
                        </Field>
                        <Field label="Categoria">
                          <select
                            name="supplierCategory"
                            defaultValue={sp.f_categoria ?? p.supplierCategory ?? ""}
                            className={inputClass}
                          >
                            <option value="">— sem categoria —</option>
                            {categoryOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Emissão">
                          <input
                            type="date"
                            name="issueDate"
                            required
                            defaultValue={sp.f_emissao ?? p.issueDate}
                            className={inputClass}
                          />
                        </Field>
                        <Field label="Vencimento">
                          <input
                            type="date"
                            name="dueDate"
                            required
                            defaultValue={sp.f_vencimento ?? p.dueDate}
                            className={inputClass}
                          />
                        </Field>
                        <Field label="Classificação do CUSTO">
                          <select
                            name="costClassification"
                            defaultValue={sp.f_custo ?? p.costClassification ?? ""}
                            className={inputClass}
                          >
                            <option value="">— sem classificação —</option>
                            <option value="fixed">Custo Fixo</option>
                            <option value="variable">Custo Variável</option>
                          </select>
                        </Field>
                        <Field label="Observações">
                          <input
                            name="notes"
                            defaultValue={sp.f_notas ?? p.notes ?? ""}
                            className={inputClass}
                          />
                        </Field>
                        <div className="flex items-end gap-2 md:col-span-3">
                          <Button variant="warn" type="submit">
                            Salvar alterações
                          </Button>
                          <Link
                            href={editHref(null)}
                            className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
                          >
                            Cancelar
                          </Link>
                          {p.status === "scheduled" ? (
                            <span className="text-xs text-amber-700">
                              Este título tem pagamento agendado: o valor não pode ser alterado até o
                              agendamento ser cancelado.
                            </span>
                          ) : null}
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : null}
                {excluir === p.id ? (
                  <tr>
                    {/* Form de EXCLUSÃO (cancelamento lógico) inline. <td> cru para colSpan,
                        como no de edição. Motivo obrigatório; em erro, a action reabre com
                        ?f_motivo preservado. */}
                    <td className="px-2 py-2 align-middle" colSpan={9}>
                      <form
                        action={cancelPayableAction}
                        className="rounded-lg border border-red-200 bg-red-50 p-3"
                      >
                        <input type="hidden" name="payableId" value={p.id} />
                        <p className="mb-2 text-sm text-[var(--crit)]">
                          O título será cancelado e permanecerá no histórico para auditoria.
                          Pagamentos pendentes vinculados também serão cancelados.
                        </p>
                        <Field label="Motivo do cancelamento">
                          <input
                            name="reason"
                            required
                            defaultValue={sp.f_motivo ?? ""}
                            className={inputClass}
                            placeholder="Ex.: compra cancelada junto ao fornecedor"
                          />
                        </Field>
                        <div className="mt-3 flex items-center gap-2">
                          <Button variant="danger" type="submit">
                            Confirmar cancelamento
                          </Button>
                          <Link
                            href={editHref(null)}
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
        <Pager page={page} basePath="/contas-a-pagar" extraQuery={extraQuery} />
      </Card>
    </div>
  );
}
