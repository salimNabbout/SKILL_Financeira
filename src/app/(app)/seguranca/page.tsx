import QRCode from "qrcode";
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

/**
 * QR Code da URI otpauth, renderizado no SERVIDOR como SVG.
 *
 * O segredo TOTP é o segundo fator: ele nunca pode sair para um serviço de
 * terceiros (nada de API externa de QR) nem depender de script no cliente. Por
 * isso a matriz é calculada aqui e desenhada como <rect> em JSX — sem
 * dangerouslySetInnerHTML e sem requisição de rede.
 *
 * Cores fixas (preto sobre branco, com zona de silêncio de 4 módulos): leitores
 * exigem alto contraste e módulos claros ao redor, então este bloco não segue o
 * tema da página de propósito.
 */
function TotpQrCode({ uri }: { uri: string }) {
  const qr = QRCode.create(uri, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const quiet = 4;
  const total = size + quiet * 2;

  const rects: React.ReactElement[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[y * size + x]) {
        rects.push(<rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} />);
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={192}
      height={192}
      role="img"
      aria-label="QR Code para cadastrar a verificação em duas etapas no aplicativo autenticador"
      shapeRendering="crispEdges"
      className="shrink-0 rounded-lg border border-[var(--line)]"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <g fill="#000000">{rects}</g>
    </svg>
  );
}

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

  const totpUri =
    totpPending && session.user.totpSecret
      ? otpauthUrl({
          issuer: "Financeira PME",
          account: session.user.email,
          secretBase32: session.user.totpSecret,
        })
      : null;

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
              Abra o aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy,
              1Password…), escolha adicionar uma conta e aponte a câmera para o QR Code abaixo. Em
              seguida confirme com o código de 6 dígitos que o aplicativo passar a exibir.
            </p>

            <div className="flex flex-wrap items-start gap-5 rounded-lg border border-[var(--line)] bg-slate-50 p-4">
              {totpUri ? <TotpQrCode uri={totpUri} /> : null}

              <div className="min-w-56 flex-1 text-xs">
                <p className="mb-1 font-semibold text-[var(--ink)]">
                  Não consegue ler o QR Code?
                </p>
                <p className="mb-2 text-[var(--ink-muted)]">
                  Escolha a opção de inserir uma chave manualmente no aplicativo e digite:
                </p>
                <p className="mb-3 break-all font-mono text-sm font-semibold tracking-wide">
                  {session.user.totpSecret}
                </p>
                <p className="text-[var(--ink-muted)]">
                  Tipo: baseada em tempo (TOTP) · 6 dígitos · 30 segundos.
                </p>
                {totpUri ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[var(--brand)]">
                      Ver a URI otpauth completa
                    </summary>
                    <p className="mt-1 break-all">
                      <code>{totpUri}</code>
                    </p>
                  </details>
                ) : null}
              </div>
            </div>

            <p className="text-xs text-[var(--ink-muted)]">
              Esta chave é o seu segundo fator: não compartilhe o QR Code nem a chave com ninguém, e
              não os envie por mensagem.
            </p>
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
