import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getContainer, isDemoMode } from "@/lib/container";
import { loginAction } from "./actions";
import { inputClass } from "@/components/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/");
  const { erro } = await searchParams;
  await getContainer(); // garante seed do modo demo antes do primeiro login

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-md p-8">
        <h1 className="text-xl font-semibold">Financeira PME</h1>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          Plataforma financeira multiagente para PMEs brasileiras
        </p>
        {isDemoMode() ? (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <strong>Modo demonstração</strong> — dados fictícios em memória. Use{" "}
            <code>ana@cafeaurora.com.br</code> (admin), <code>bruno@cafeaurora.com.br</code>{" "}
            (gestor), <code>carla@cafeaurora.com.br</code> (analista) ou{" "}
            <code>diego@cafeaurora.com.br</code> (aprovador), senha <code>demo1234</code>.
          </p>
        ) : null}
        {erro ? (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-[var(--crit)]">{erro}</p>
        ) : null}
        <form action={loginAction} className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">E-mail</span>
            <input name="email" type="email" required className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Senha</span>
            <input name="password" type="password" required className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              Código 2FA{" "}
              <span className="font-normal text-[var(--ink-muted)]">
                (apenas se ativado na sua conta)
              </span>
            </span>
            <input
              name="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              className={inputClass}
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg bg-[var(--brand)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Entrar
          </button>
        </form>
      </div>
    </main>
  );
}
