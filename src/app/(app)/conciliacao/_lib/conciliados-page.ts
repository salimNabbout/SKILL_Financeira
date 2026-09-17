/**
 * Paginação do card "Conciliados" da tela de Conciliação (?pc=N).
 *
 * O card mostrava só os 30 pagamentos conciliados mais recentes, sem como
 * chegar aos demais. A lista continua ordenada do mais recente para o mais
 * antigo; esta função só diz qual janela dela a página pedida exibe. Função
 * pura, no molde de `_lib/filters.ts`.
 */

import { pageOffset } from "@/app/(app)/_lib/pager";

export const CONCILIADOS_POR_PAGINA = 30;

export interface ConciliadosPage {
  total: number;
  offset: number;
  limit: number;
}

/**
 * Janela da página pedida sobre `total` conciliados. Página inexistente
 * (além da última, zero, negativa ou não numérica) não devolve tabela vazia:
 * além da última cai na última; inválida cai na primeira — mesma leitura do
 * `pageOffset` compartilhado.
 */
export function conciliadosPage(
  total: number,
  pc: string | undefined,
  limit: number = CONCILIADOS_POR_PAGINA
): ConciliadosPage {
  const ultimaPagina = Math.max(1, Math.ceil(total / limit));
  const offset = Math.min(pageOffset(pc, limit), (ultimaPagina - 1) * limit);
  return { total, offset, limit };
}
