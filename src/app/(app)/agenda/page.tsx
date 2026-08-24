import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, StatCard, Table, Td } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBR, formatBRL } from "@/lib/format";
import {
  addMonths,
  endOfMonth,
  monthOf,
  startOfMonth,
  todayInTz,
  type ISODate,
  type ISOMonth,
} from "@/core/dates";
import type { Payable, PayableStatus, Receivable, ReceivableStatus } from "@/core/entities";
import { payableRemainingCents, receivableRemainingCents } from "@/core/money";

// Mesma semântica de OPEN_STATUSES da skill contas-a-pagar: só títulos em
// aberto entram na agenda (pagos/recebidos e cancelados ficam de fora).
const PAYABLE_OPEN: PayableStatus[] = ["open", "partially_paid", "scheduled"];
const RECEIVABLE_OPEN: ReceivableStatus[] = ["open", "partially_received"];

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** Item de título já resolvido para exibição (nome da contraparte + saldo). */
interface AgendaItem {
  id: string;
  party: string;
  description: string;
  remainingCents: number;
  dueDate: ISODate;
}

interface DayCell {
  day: number; // 1..N
  date: ISODate;
  payables: AgendaItem[];
  receivables: AgendaItem[];
  outCents: number; // saídas (a pagar)
  inCents: number; // entradas (a receber)
  netCents: number; // entradas - saídas
}

export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; mes?: string }>;
}) {
  const { ano, mes } = await searchParams;
  const session = await requireSession();
  const { repos, clock } = await getContainer();
  const companyId = session.company.id;
  const today = todayInTz(clock.now(), session.config.timezone);

  // Mês exibido: dos searchParams (validados), senão o mês de hoje.
  const anoNum = ano && /^\d{4}$/.test(ano) ? Number(ano) : Number(today.slice(0, 4));
  const mesNum =
    mes && /^\d{1,2}$/.test(mes) && Number(mes) >= 1 && Number(mes) <= 12
      ? Number(mes)
      : Number(today.slice(5, 7));
  const month: ISOMonth = `${anoNum}-${String(mesNum).padStart(2, "0")}`;
  const inicioDoMes = startOfMonth(month); // dia 1
  const fimDoMes = endOfMonth(month); // último dia real (fev/30 dias/bissexto)

  // DUAS consultas de títulos (mês inteiro), agregadas em memória — nunca uma
  // query por dia. Nomes de contraparte via listAll + Map (sem getById em loop).
  const [payablesRaw, receivablesRaw, suppliers, customers] = await Promise.all([
    repos.payables.listDueBetween(companyId, inicioDoMes, fimDoMes),
    repos.receivables.listDueBetween(companyId, inicioDoMes, fimDoMes),
    repos.suppliers.listAll(companyId),
    repos.customers.listAll(companyId),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  const payables = payablesRaw.filter((p) => PAYABLE_OPEN.includes(p.status));
  const receivables = receivablesRaw.filter((r) => RECEIVABLE_OPEN.includes(r.status));

  const daysInMonth = Number(fimDoMes.slice(8, 10));
  // Dia da semana (0=Dom) do dia 1 — para as células vazias iniciais.
  const firstWeekday = new Date(Date.UTC(anoNum, mesNum - 1, 1)).getUTCDay();

  // Estrutura por dia (índice 1..daysInMonth).
  const cells: DayCell[] = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    return {
      day,
      date: `${month}-${String(day).padStart(2, "0")}`,
      payables: [],
      receivables: [],
      outCents: 0,
      inCents: 0,
      netCents: 0,
    };
  });

  for (const p of payables) {
    const day = Number(p.dueDate.slice(8, 10));
    const cell = cells[day - 1];
    if (!cell) continue;
    const remainingCents = payableRemainingCents(p);
    cell.payables.push({
      id: p.id,
      party: supplierName.get(p.supplierId) ?? p.supplierId,
      description: p.description,
      remainingCents,
      dueDate: p.dueDate,
    });
    cell.outCents += remainingCents;
  }
  for (const r of receivables) {
    const day = Number(r.dueDate.slice(8, 10));
    const cell = cells[day - 1];
    if (!cell) continue;
    const remainingCents = receivableRemainingCents(r);
    cell.receivables.push({
      id: r.id,
      party: customerName.get(r.customerId) ?? r.customerId,
      description: r.description,
      remainingCents,
      dueDate: r.dueDate,
    });
    cell.inCents += remainingCents;
  }
  for (const c of cells) c.netCents = c.inCents - c.outCents;

  // Consolidado do mês.
  const monthOutCents = cells.reduce((acc, c) => acc + c.outCents, 0);
  const monthInCents = cells.reduce((acc, c) => acc + c.inCents, 0);
  const monthNetCents = monthInCents - monthOutCents;
  const hasMovement = payables.length > 0 || receivables.length > 0;

  // Navegação de mês.
  const prevMonth = monthOf(addMonths(inicioDoMes, -1));
  const nextMonth = monthOf(addMonths(inicioDoMes, 1));
  const [prevAno, prevMes] = prevMonth.split("-");
  const [nextAno, nextMes] = nextMonth.split("-");
  const todayMonth = monthOf(today);
  const isCurrentMonth = month === todayMonth;

  // Grade: células vazias antes do dia 1 e depois do último dia (para completar
  // a última semana). São 7 colunas (Dom..Sáb).
  const leadingBlanks = Array.from({ length: firstWeekday }, (_, i) => i);
  const totalSlots = firstWeekday + daysInMonth;
  const trailingBlanks = Array.from({ length: (7 - (totalSlots % 7)) % 7 }, (_, i) => i);

  // Detalhamento: títulos do mês ordenados por vencimento.
  const monthPayables = [...payables]
    .map((p) => ({
      id: p.id,
      party: supplierName.get(p.supplierId) ?? p.supplierId,
      description: p.description,
      remainingCents: payableRemainingCents(p),
      dueDate: p.dueDate,
    }))
    .sort((a, b) => (a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate.localeCompare(b.dueDate)));
  const monthReceivables = [...receivables]
    .map((r) => ({
      id: r.id,
      party: customerName.get(r.customerId) ?? r.customerId,
      description: r.description,
      remainingCents: receivableRemainingCents(r),
      dueDate: r.dueDate,
    }))
    .sort((a, b) => (a.dueDate === b.dueDate ? a.id.localeCompare(b.id) : a.dueDate.localeCompare(b.dueDate)));

  function isOverdue(cell: DayCell): boolean {
    return cell.date < today && (cell.payables.length > 0 || cell.receivables.length > 0);
  }

  return (
    <div>
      <PageHeader
        title="Agenda financeira"
        subtitle="Vencimentos a pagar e a receber por DATA DE VENCIMENTO (não por liquidação): títulos vencidos e ainda em aberto aparecem no dia do vencimento. Somente títulos em aberto; valores pelo saldo restante."
      />

      {/* Navegação de mês */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          href={`/agenda?ano=${prevAno}&mes=${Number(prevMes)}`}
          className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          ◀ Mês anterior
        </Link>
        <span className="text-base font-semibold">
          {MESES[mesNum - 1]} de {anoNum}
        </span>
        <Link
          href={`/agenda?ano=${nextAno}&mes=${Number(nextMes)}`}
          className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
        >
          Próximo mês ▶
        </Link>
        {!isCurrentMonth ? (
          <Link href="/agenda" className="text-sm text-[var(--brand)] underline">
            Hoje
          </Link>
        ) : null}
      </div>

      {/* Consolidado do mês */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="A receber no mês" value={formatBRL(monthInCents)} tone="ok" />
        <StatCard label="A pagar no mês" value={formatBRL(monthOutCents)} tone="warn" />
        <StatCard
          label="Líquido do mês"
          value={formatBRL(monthNetCents)}
          tone={monthNetCents >= 0 ? "ok" : "crit"}
        />
      </div>

      {!hasMovement ? (
        <Card>
          <EmptyState message={`Nenhum vencimento em aberto em ${MESES[mesNum - 1]} de ${anoNum}.`} />
        </Card>
      ) : (
        <>
          {/* Grade de calendário (md+) */}
          <Card className="mb-6 hidden md:block">
            <div className="grid grid-cols-7 gap-px">
              {DIAS_SEMANA.map((d) => (
                <div
                  key={d}
                  className="bg-[var(--muted)] px-2 py-1 text-center text-xs font-semibold uppercase text-[var(--ink-muted)]"
                >
                  {d}
                </div>
              ))}
              {leadingBlanks.map((i) => (
                <div key={`lead-${i}`} className="min-h-24 bg-slate-50/50 opacity-50" />
              ))}
              {cells.map((cell) => {
                const overdue = isOverdue(cell);
                const isToday = cell.date === today;
                return (
                  <div
                    key={cell.date}
                    className={`min-h-24 border p-1.5 text-xs ${
                      isToday
                        ? "border-[var(--brand)] bg-[var(--brand)]/5"
                        : overdue
                          ? "border-red-200 bg-red-50"
                          : "border-[var(--line)]"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className={`font-semibold ${isToday ? "text-[var(--brand)]" : ""}`}>
                        {cell.day}
                      </span>
                      {isToday ? <Badge tone="brand">Hoje</Badge> : null}
                    </div>
                    {cell.inCents > 0 ? (
                      <p className="tabular text-[var(--ok)]">+{formatBRL(cell.inCents)}</p>
                    ) : null}
                    {cell.outCents > 0 ? (
                      <p className="tabular text-[var(--crit)]">−{formatBRL(cell.outCents)}</p>
                    ) : null}
                  </div>
                );
              })}
              {trailingBlanks.map((i) => (
                <div key={`trail-${i}`} className="min-h-24 bg-slate-50/50 opacity-50" />
              ))}
            </div>
          </Card>

          {/* Lista vertical (telas estreitas) */}
          <Card className="mb-6 md:hidden">
            <ul className="divide-y divide-[var(--line)]">
              {cells
                .filter((c) => c.payables.length > 0 || c.receivables.length > 0)
                .map((cell) => {
                  const overdue = isOverdue(cell);
                  const isToday = cell.date === today;
                  return (
                    <li key={cell.date} className={`py-2 ${overdue ? "text-[var(--crit)]" : ""}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">
                          {formatBR(cell.date)}
                          {isToday ? " · hoje" : overdue ? " · vencido" : ""}
                        </span>
                        <span className="tabular text-sm">
                          {cell.inCents > 0 ? (
                            <span className="text-[var(--ok)]">+{formatBRL(cell.inCents)} </span>
                          ) : null}
                          {cell.outCents > 0 ? (
                            <span className="text-[var(--crit)]">−{formatBRL(cell.outCents)}</span>
                          ) : null}
                        </span>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </Card>

          {/* Detalhamento do mês */}
          <Card className="mb-6" title="Detalhamento do mês — a pagar">
            {monthPayables.length === 0 ? (
              <EmptyState message="Nenhum título a pagar vencendo neste mês." />
            ) : (
              <Table headers={["Vencimento", "Fornecedor", "Descrição", "Saldo", ""]} align={["l", "l", "l", "r", "l"]}>
                {monthPayables.map((it) => (
                  <tr key={it.id}>
                    <Td>{formatBR(it.dueDate)}</Td>
                    <Td>{it.party}</Td>
                    <Td>{it.description}</Td>
                    <Td right>{formatBRL(it.remainingCents)}</Td>
                    <Td>
                      <Link href="/contas-a-pagar" className="text-sm text-[var(--brand)] underline">
                        Ver
                      </Link>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Detalhamento do mês — a receber">
            {monthReceivables.length === 0 ? (
              <EmptyState message="Nenhum título a receber vencendo neste mês." />
            ) : (
              <Table headers={["Vencimento", "Cliente", "Descrição", "Saldo", ""]} align={["l", "l", "l", "r", "l"]}>
                {monthReceivables.map((it) => (
                  <tr key={it.id}>
                    <Td>{formatBR(it.dueDate)}</Td>
                    <Td>{it.party}</Td>
                    <Td>{it.description}</Td>
                    <Td right>{formatBRL(it.remainingCents)}</Td>
                    <Td>
                      <Link href="/contas-a-receber" className="text-sm text-[var(--brand)] underline">
                        Ver
                      </Link>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
