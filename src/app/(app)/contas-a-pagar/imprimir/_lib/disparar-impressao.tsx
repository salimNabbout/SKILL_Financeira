"use client";

import { useEffect } from "react";

/**
 * Abre a caixa de impressão ao carregar a visão.
 *
 * Único trecho cliente da tela — a página em si segue Server Component. O
 * disparo espera o próximo quadro para a tabela já estar pintada: chamar
 * print() antes disso imprime a página em branco em alguns navegadores.
 */
export function DispararImpressao() {
  useEffect(() => {
    const id = window.requestAnimationFrame(() => window.print());
    return () => window.cancelAnimationFrame(id);
  }, []);
  return null;
}
