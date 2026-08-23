import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass, statusTone } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL, statusLabel } from "@/lib/format";
import { endOfMonth, isISODate, startOfMonth, todayInTz, type ISODate } from "@/core/dates";
import type { PayableStatus } from "@/core/entities";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { schedulePaymentAction } from "./actions";
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
  }>;
}) {
  const { status, p, ok, erro, ano, mes, fornecedor, de, ate } = await searchParams;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
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

  return (
    <div>
      <PageHeader
        title="Contas a pagar"
        subtitle="Títulos de fornecedores, vencimentos e agendamento de pagamentos (sempre com aprovação humana)."
      />
      <Flash ok={ok} erro={erro} />

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
            headers={["Fornecedor", "Descrição", "Parcela", "Vencimento", "Valor", "Pago", "Status", "Pagar"]}
            align={["l", "l", "l", "l", "r", "r", "l", "l"]}
          >
            {rows.map((p) => {
              const overdue = p.dueDate < today && p.status !== "paid" && p.status !== "canceled";
              return (
                <tr key={p.id}>
                  <Td>{supplierName.get(p.supplierId) ?? p.supplierId}</Td>
                  <Td>{p.description}</Td>
                  <Td>{`${p.installmentNumber}/${p.installmentCount}`}</Td>
                  <Td>
                    <span className={overdue ? "font-semibold text-[var(--crit)]" : ""}>
                      {formatBR(p.dueDate)}
                    </span>
                  </Td>
                  <Td right>{formatBRL(p.amountCents)}</Td>
                  <Td right>{formatBRL(p.paidCents)}</Td>
                  <Td>
                    <Badge tone={statusTone(p.status)}>{statusLabel(p.status)}</Badge>
                  </Td>
                  <Td>
                    {SCHEDULABLE.includes(p.status) ? (
                      <form action={schedulePaymentAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="payableId" value={p.id} />
                        <select name="bankAccountId" required className={`${inputClass} w-36`}>
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
                          className={`${inputClass} w-36`}
                        />
                        <Button variant="success">Pagar</Button>
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
        <Pager page={page} basePath="/contas-a-pagar" extraQuery={extraQuery} />
      </Card>

      <Card title="Novo título">
        <NewPayableForm suppliers={supplierOptions} categories={categoryOptions} today={today} />
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          O título passa pelo fluxo de entrada de nota (validação de duplicidade, projeção de caixa e
          impacto orçamentário). Valores em reais são convertidos para centavos.
        </p>
      </Card>
    </div>
  );
}
