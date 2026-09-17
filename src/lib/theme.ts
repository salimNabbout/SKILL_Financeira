/**
 * Tema claro/escuro.
 *
 * A escolha é do NAVEGADOR (preferência de exibição), não da conta: não vai ao
 * banco nem à auditoria. A fonte da verdade é o cookie `theme`, que o layout
 * raiz lê NO SERVIDOR para renderizar `<html data-theme=…>` já certo em toda
 * carga de página — navegação, formulário GET, server action com redirect e
 * recarga apenas releem o que está no cookie.
 *
 * SÓ o botão "Tema claro / Tema escuro" grava esse cookie. Nenhuma outra tela,
 * botão ou ação mexe no tema. Antes, o tema vivia só no `localStorage` e, sem
 * escolha salva (ou com o armazenamento bloqueado), cada carga de página
 * refazia a decisão pela preferência do sistema operacional — o que fazia
 * qualquer botão que navegasse parecer "trocar o tema".
 *
 * Sem cookie (1ª visita), o script inline resolve UMA vez — escolha legada do
 * `localStorage`, senão a preferência do sistema — e grava o cookie, travando
 * a decisão dali em diante.
 */

export type Theme = "light" | "dark";

export const THEME_COOKIE = "theme";

/** Um ano: a escolha só muda quando o botão gravar outra. */
export const THEME_MAX_AGE = 60 * 60 * 24 * 365;

export function parseTheme(value: string | null | undefined): Theme | undefined {
  return value === "dark" || value === "light" ? value : undefined;
}

/** Cookie que o botão grava (client-side). `Secure` só em https. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Script inline do layout raiz — roda ANTES da primeira pintura (por isso é
 * síncrono e inline). Se o servidor já renderizou `data-theme` a partir do
 * cookie, não faz nada. Só na 1ª visita resolve o tema e grava o cookie.
 */
export const THEME_INIT = [
  "(function(){try{",
  'var d=document.documentElement;var t=d.getAttribute("data-theme");',
  'if(t==="dark"||t==="light"){return;}',
  'try{t=localStorage.getItem("theme");}catch(e){t=null;}',
  'if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}',
  'd.setAttribute("data-theme",t);',
  `document.cookie="${THEME_COOKIE}="+t+"; Path=/; Max-Age=${THEME_MAX_AGE}; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");`,
  "}catch(e){}})();",
].join("");
