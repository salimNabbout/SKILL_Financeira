import Link from "next/link";
import { cookies } from "next/headers";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { hasPermission } from "@/core/auth";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { ROLE_LABELS, formatBRL } from "@/lib/format";
import { ASSIGNABLE_ROLES } from "@/lib/user-admin";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { inviteUserAction, toggleUserActiveAction, updateMembershipAction } from "./actions";
import { FLASH_SECRET_COOKIE } from "./flash";

export default async function UsuariosPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const session = await requireSession();
  const { repos } = await getContainer();
  const { ok, erro } = await searchParams;
  const canManage = hasPermission(session.membership.role, "user.manage");

  // Segredo de uso único (senha temporária do convite mock) — cookie de 60s,
  // nunca via querystring, exibido apenas na empresa onde o convite foi feito.
  let secretFlash: string | undefined;
  if (canManage) {
    const raw = (await cookies()).get(FLASH_SECRET_COOKIE)?.value;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { companyId?: string; message?: string };
        if (parsed.companyId === session.company.id) secretFlash = parsed.message;
      } catch {
        // cookie legado/corrompido: ignora
      }
    }
  }

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

      <Flash ok={ok} erro={erro} />
      {secretFlash ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          🔑 <strong>{secretFlash}</strong> — anote agora: esta senha é exibida uma única vez
          (convite mock; nenhum e-mail foi enviado). Peça a troca no primeiro acesso.
        </p>
      ) : null}

      {canManage ? (
        <Card className="mb-4" title="Convidar usuário">
          <form action={inviteUserAction} className="grid gap-4 md:grid-cols-4">
            <Field label="Nome">
              <input name="name" required className={inputClass} />
            </Field>
            <Field label="E-mail">
              <input name="email" type="email" required className={inputClass} />
            </Field>
            <Field label="Papel">
              <select name="role" required className={inputClass} defaultValue="finance_analyst">
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Limite de alçada (R$)">
              <input name="approvalLimit" placeholder="vazio = ilimitado no papel" className={inputClass} />
            </Field>
            <div className="md:col-span-4 flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--ink-muted)]">
                E-mail já cadastrado em outra empresa? Ele será apenas vinculado (mantém a senha).
                Convite por e-mail real chega com as integrações da v1.2 — por ora é mock.
              </p>
              <Button>Convidar</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card className="mb-4">
        {rows.length === 0 ? (
          <EmptyState message="Nenhum usuário vinculado à empresa." />
        ) : (
          <Table
            headers={
              canManage
                ? ["Nome", "E-mail", "Papel e alçada", "Situação", "Ações"]
                : ["Nome", "E-mail", "Papel", "Limite de alçada", "Situação"]
            }
            align={["l", "l", "l", "l", "l"]}
          >
            {rows.map(({ membership, user }) => {
              const isSelf = user!.id === session.user.id;
              return (
                <tr key={membership.id}>
                  <Td>{user!.name}</Td>
                  <Td>{user!.email}</Td>
                  {canManage ? (
                    <>
                      <Td>
                        {isSelf ? (
                          <Badge tone="brand">{ROLE_LABELS[membership.role] ?? membership.role}</Badge>
                        ) : (
                          <form action={updateMembershipAction} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="userId" value={user!.id} />
                            <select name="role" defaultValue={membership.role} className={`${inputClass} w-auto`}>
                              {ASSIGNABLE_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r] ?? r}
                                </option>
                              ))}
                            </select>
                            <input
                              name="approvalLimit"
                              defaultValue={
                                membership.approvalLimitCents === null
                                  ? ""
                                  : (membership.approvalLimitCents / 100).toFixed(2).replace(".", ",")
                              }
                              placeholder="Alçada R$ (vazio = ilimitada)"
                              className={`${inputClass} w-40`}
                            />
                            <Button variant="secondary">Salvar</Button>
                          </form>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={user!.active ? "ok" : "neutral"}>
                          {user!.active ? "Ativo" : "Inativo"}
                        </Badge>
                      </Td>
                      <Td>
                        {isSelf ? (
                          <span className="text-xs text-[var(--ink-muted)]">
                            (você — peça a outro admin)
                          </span>
                        ) : (
                          <form action={toggleUserActiveAction}>
                            <input type="hidden" name="userId" value={user!.id} />
                            <input type="hidden" name="active" value={user!.active ? "0" : "1"} />
                            <Button variant={user!.active ? "danger" : "secondary"}>
                              {user!.active ? "Desativar" : "Reativar"}
                            </Button>
                          </form>
                        )}
                      </Td>
                    </>
                  ) : (
                    <>
                      <Td>
                        <Badge tone="brand">{ROLE_LABELS[membership.role] ?? membership.role}</Badge>
                      </Td>
                      <Td>
                        {membership.approvalLimitCents === null
                          ? "Ilimitado (dentro do papel)"
                          : formatBRL(membership.approvalLimitCents)}
                      </Td>
                      <Td>
                        <Badge tone={user!.active ? "ok" : "neutral"}>
                          {user!.active ? "Ativo" : "Inativo"}
                        </Badge>
                      </Td>
                    </>
                  )}
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <p className="rounded-lg border border-dashed border-[var(--line)] p-3 text-sm text-[var(--ink-muted)]">
        Governança aplicada automaticamente: a empresa nunca fica sem administrador ativo, ninguém
        altera o próprio papel nem desativa a si mesmo, e toda mudança vai para a trilha de
        auditoria. Atenção: desativar um usuário bloqueia o login dele em <em>todas</em> as
        empresas em que atua (o cadastro é global).
      </p>
    </div>
  );
}
