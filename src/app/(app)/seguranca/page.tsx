import { Badge, Button, Card, Field, PageHeader, inputClass } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { otpauthUrl } from "@/lib/totp";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import {
  changePasswordAction,
  confirmTotpAction,
  disableTotpAction,
  startTotpSetupAction,
} from "./actions";

export default async function SegurancaPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>;
}) {
  const { ok, erro } = await searchParams;
  const session = await requireSession();
  const policy = session.config.passwordPolicy;
  const totpPending = !!session.user.totpSecret && !session.user.totpEnabled;
  const totpActive = session.user.totpEnabled === true;

  const requirements = [
    `mínimo de ${policy.minLength} caracteres`,
    ...(policy.requireUppercase ? ["uma letra maiúscula"] : []),
    ...(policy.requireLowercase ? ["uma letra minúscula"] : []),
    ...(policy.requireDigit ? ["um dígito"] : []),
  ].join(", ");

  return (
    <div>
      <PageHeader
        title="Segurança da conta"
        subtitle="Troca de senha (política configurável por empresa) e verificação em duas etapas (TOTP)."
      />
      <Flash ok={ok} erro={erro} />

      <Card className="mb-6" title="Trocar senha">
        <form action={changePasswordAction} className="grid gap-4 md:grid-cols-3">
          <Field label="Senha atual">
            <input type="password" name="currentPassword" required className={inputClass} />
          </Field>
          <Field label="Nova senha">
            <input type="password" name="newPassword" required className={inputClass} />
          </Field>
          <Field label="Confirmar nova senha">
            <input type="password" name="confirmPassword" required className={inputClass} />
          </Field>
          <div className="flex items-end">
            <Button>Alterar senha</Button>
          </div>
          <p className="md:col-span-3 text-xs text-[var(--ink-muted)]">
            Política desta empresa: {requirements}. A troca é auditada (sem registrar a senha).
          </p>
        </form>
      </Card>

      <Card title="Verificação em duas etapas (2FA — TOTP)">
        <p className="mb-3 text-sm">
          Status:{" "}
          {totpActive ? (
            <Badge tone="ok">Ativa</Badge>
          ) : totpPending ? (
            <Badge tone="warn">Aguardando confirmação</Badge>
          ) : (
            <Badge tone="neutral">Inativa</Badge>
          )}
        </p>

        {totpActive ? (
          <form action={disableTotpAction} className="flex flex-wrap items-end gap-3">
            <Field label="Código atual do aplicativo">
              <input
                name="code"
                required
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                className={`${inputClass} w-32`}
              />
            </Field>
            <Button variant="danger">Desativar 2FA</Button>
            <p className="w-full text-xs text-[var(--ink-muted)]">
              A desativação exige um código válido e é registrada na auditoria.
            </p>
          </form>
        ) : totpPending ? (
          <div className="space-y-3">
            <p className="text-sm">
              Cadastre a conta no seu aplicativo autenticador (Google Authenticator, Authy,
              1Password…) usando a chave abaixo — por leitura da URI ou digitando a chave
              manualmente — e confirme com o código de 6 dígitos gerado.
            </p>
            <div className="rounded-lg border border-[var(--line)] bg-slate-50 p-3 text-xs">
              <p>
                Chave (base32): <code className="font-semibold">{session.user.totpSecret}</code>
              </p>
              <p className="mt-1 break-all">
                URI:{" "}
                <code>
                  {otpauthUrl({
                    issuer: "Financeira PME",
                    account: session.user.email,
                    secretBase32: session.user.totpSecret!,
                  })}
                </code>
              </p>
            </div>
            <form action={confirmTotpAction} className="flex flex-wrap items-end gap-3">
              <Field label="Código de 6 dígitos">
                <input
                  name="code"
                  required
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  className={`${inputClass} w-32`}
                />
              </Field>
              <Button>Confirmar e ativar</Button>
            </form>
            <form action={startTotpSetupAction}>
              <Button variant="secondary">Gerar outra chave</Button>
            </form>
          </div>
        ) : (
          <form action={startTotpSetupAction}>
            <p className="mb-3 text-sm">
              Com a 2FA ativa, o login passa a exigir — além da senha — um código de 6 dígitos do
              seu aplicativo autenticador (padrão TOTP, janela de 30 segundos).
            </p>
            <Button>Ativar 2FA</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
