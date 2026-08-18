import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { formatBR, formatBRL } from "@/lib/format";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { createBankAccountAction } from "./actions";

const TYPE_LABELS: Record<string, string> = {
  checking: "Conta corrente",
  savings: "Poupança",
  payment: "Conta de pagamento",
};

export default async function ContasBancariasPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const { repos } = await getContainer();
  const accounts = await repos.bankAccounts.listAll(session.company.id);
  const canManage = hasPermission(session.membership.role, "bank_account.manage");
  const rows = [...accounts].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Contas bancárias"
        subtitle="Contas da empresa para pagamentos, recebimentos e conciliação. Números são sempre mascarados."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6">
        {rows.length === 0 ? (
          <EmptyState message="Nenhuma conta bancária cadastrada." />
        ) : (
          <Table
            headers={["Nome", "Banco", "Agência", "Conta", "Tipo", "Saldo inicial", "Data do saldo", "Situação"]}
            align={["l", "l", "l", "l", "l", "r", "l", "l"]}
          >
            {rows.map((b) => (
              <tr key={b.id}>
                <Td>{b.name}</Td>
                <Td>{b.bankCode}</Td>
                <Td>{b.agency}</Td>
                <Td>
                  <span className="tabular">{b.accountNumberMasked}</span>
                </Td>
                <Td>{TYPE_LABELS[b.type] ?? b.type}</Td>
                <Td right>{formatBRL(b.openingBalanceCents)}</Td>
                <Td>{formatBR(b.openingBalanceDate)}</Td>
                <Td>
                  <Badge tone={b.active ? "ok" : "neutral"}>{b.active ? "Ativa" : "Inativa"}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card title="Nova conta bancária">
          <form action={createBankAccountAction} className="grid gap-4 md:grid-cols-3">
            <Field label="Nome de exibição">
              <input name="name" required className={inputClass} placeholder="Ex.: Banco do Brasil — principal" />
            </Field>
            <Field label="Código do banco">
              <input name="bankCode" required className={inputClass} placeholder="Ex.: 001" />
            </Field>
            <Field label="Agência">
              <input name="agency" required className={inputClass} placeholder="Ex.: 1234-5" />
            </Field>
            <Field label="Número completo da conta">
              <input name="accountNumber" required className={inputClass} placeholder="Ex.: 45678-9" />
            </Field>
            <Field label="Tipo">
              <select name="type" required className={inputClass}>
                <option value="checking">Conta corrente</option>
                <option value="savings">Poupança</option>
                <option value="payment">Conta de pagamento</option>
              </select>
            </Field>
            <Field label="Saldo inicial (R$)">
              <input name="openingBalance" className={inputClass} placeholder="0,00" inputMode="decimal" />
            </Field>
            <Field label="Data do saldo inicial">
              <input type="date" name="openingBalanceDate" required className={inputClass} />
            </Field>
            <div className="flex items-end">
              <Button>Cadastrar</Button>
            </div>
          </form>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            Segurança: apenas os 4 últimos dígitos do número da conta são armazenados
            (máscara ****-0000). O número completo não é persistido nem auditado.
          </p>
        </Card>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite gerenciar contas bancárias — visualização apenas.
        </p>
      )}
    </div>
  );
}
