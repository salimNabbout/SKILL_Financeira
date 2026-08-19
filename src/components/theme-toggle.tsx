"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Botão de tema claro/escuro.
 *
 * A escolha vale para o navegador (localStorage), não para a conta: é
 * preferência de exibição, não dado da empresa — por isso não vai ao banco nem
 * aparece na auditoria. O tema é aplicado antes da primeira pintura pelo script
 * inline do layout raiz; aqui só alternamos o atributo e persistimos.
 */
export function ThemeToggle() {
  // Começa nulo: o servidor não sabe qual tema o navegador escolheu, e assumir
  // um valor causaria divergência na hidratação.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem("theme", next);
    } catch {
      // Navegador com armazenamento bloqueado: o tema vale só nesta aba.
    }
    setTheme(next);
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isDark}
      // Enquanto o tema não foi lido, o rótulo fica neutro para não piscar
      // "Modo escuro" e trocar logo em seguida.
      title={theme === null ? "Alternar tema" : isDark ? "Usar tema claro" : "Usar tema escuro"}
      className="flex w-full items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-xs text-[var(--ink)] hover:bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand)]"
    >
      <span aria-hidden="true" className="text-[var(--ink-muted)]">
        {isDark ? (
          // Sol: clicar volta para o tema claro.
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        ) : (
          // Lua: clicar vai para o tema escuro.
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        )}
      </span>
      {theme === null ? "Tema" : isDark ? "Tema claro" : "Tema escuro"}
    </button>
  );
}
