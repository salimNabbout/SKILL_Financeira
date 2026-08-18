import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { ROLE_LABELS, formatBRL } from "@/lib/format";

export default async function UsuariosPage() {
  const session = await requireSession();
  const { repos } = await getContainer();

  const memberships = await repos.memberships.listByCompany(session.company.id);
  const users = await Promise.all(memberships.map((m) => repos.users.getById(m.userId)));
  const rows = memberships
    .map((m, i) => ({ membership: m, user: users[i] }))
    .filter((r) => r.user !== null)
    .sort((a, b) => (a.user!.name ?? "").localeCompare(b.user!.name ?? "", "pt-BR"));

  return (
    <div>
      <PageHeader
        title="Usuários"
        subtitle="Pessoas com acesso à empresa, papéis (RBAC) e limites de alçada de aprovação."
        actions={<Link href="/cadastros" className="text-sm text-[var(--brand)] underline">← Cadastros</Link>}
      />

      <Card className="mb-4">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum usuário vinculado à empresa." />
        ) : (
          <Table
            headers={["Nome", "E-mail", "Papel", "Limite de alçada", "Situação"]}
            align={["l", "l", "l", "r", "l"]}
          >
            {rows.map(({ membership, user }) => (
              <tr key={membership.id}>
                <Td>{user!.name}</Td>
                <Td>{user!.email}</Td>
                <Td>
                  <Badge tone="brand">{ROLE_LABELS[membership.role] ?? membership.role}</Badge>
                </Td>
                <Td right>
                  {membership.approvalLimitCents === null
                    ? "Ilimitado (dentro do papel)"
                    : formatBRL(membership.approvalLimitCents)}
                </Td>
                <Td>
                  <Badge tone={user!.active ? "ok" : "neutral"}>
                    {user!.active ? "Ativo" : "Inativo"}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="rounded-lg border border-dashed border-[var(--line)] p-3 text-sm text-[var(--ink-muted)]">
        Criação e edição de usuários chega na v2 — no MVP, os acessos são provisionados pelo
        administrador do ambiente (seed/da implantação).
      </p>
    </div>
  );
}
