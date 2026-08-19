import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Financeira PME",
  description:
    "Plataforma financeira multiagente para PMEs brasileiras — skills especializadas com orquestrador central",
};

/*
 * Aplica o tema ANTES da primeira pintura, evitando o flash de tela clara em
 * quem usa o tema escuro. Precisa ser síncrono e inline — qualquer caminho
 * assíncrono (efeito do React, script externo) pinta claro primeiro. Sem
 * escolha salva, segue a preferência do sistema operacional.
 */
const THEME_INIT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
