import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Financeira PME",
  description:
    "Plataforma financeira multiagente para PMEs brasileiras — skills especializadas com orquestrador central",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
