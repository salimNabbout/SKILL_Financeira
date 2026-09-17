import type { Metadata } from "next";
import { cookies } from "next/headers";
import { THEME_COOKIE, THEME_INIT, parseTheme } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Financeira PME",
  description:
    "Plataforma financeira multiagente para PMEs brasileiras — skills especializadas com orquestrador central",
};

/*
 * Tema claro/escuro: o servidor renderiza `data-theme` a partir do cookie que
 * SÓ o botão "Tema claro / Tema escuro" grava (src/lib/theme.ts). Assim toda
 * carga de página — navegação, formulário GET, server action, recarga — sai
 * do servidor já com o tema escolhido, sem depender de JavaScript, do
 * localStorage nem da preferência do sistema. O script inline só age na 1ª
 * visita (sem cookie): resolve o tema antes da primeira pintura, evitando o
 * flash de tela clara, e grava o cookie para travar a escolha.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="pt-BR" data-theme={theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
