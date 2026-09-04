/**
 * Filtros da tela de Conciliação: conta bancária e período.
 *
 * A tela não tinha filtro nenhum até a caixa "Saldo" existir — e o saldo só faz
 * sentido recortado por conta e por intervalo. Função pura, sem dependência de
 * Next/server, no mesmo molde de contas-a-pagar/_lib/filters.ts.
 */

import { isISODate, monthOf, startOfMonth, type ISODate } from "@/core/dates";
import type { BankAccount, ID } from "@/core/entities";

export interface ConciliacaoFilterParams {
  conta?: string;
  de?: string;
  ate?: string;
}

export interface ConciliacaoFilters {
  /** Conta escolhida, ou `undefined` quando a empresa não tem conta ativa. */
  bankAccountId?: ID;
  from: ISODate;
  to: ISODate;
  /** Data inicial maior que a final: a página redireciona com o aviso. */
  periodoInvalido: boolean;
}

/**
 * Resolve os filtros a partir dos searchParams.
 *
 * Defaults: a primeira conta ATIVA quando nenhuma foi escolhida (ou quando a
 * escolhida não existe mais / foi desativada), e "do início do mês até hoje"
 * quando o período vem vazio — é o recorte que um saldo responde. `hoje` chega
 * de fora já no fuso da empresa; calcular o mês em UTC faria a tela pular um
 * dia na virada.
 */
export function resolveFilters(
  sp: ConciliacaoFilterParams,
  accounts: BankAccount[],
  hoje: ISODate
): ConciliacaoFilters {
  const ativas = accounts.filter((a) => a.active);
  const escolhida = sp.conta && ativas.some((a) => a.id === sp.conta) ? sp.conta : undefined;
  const bankAccountId = escolhida ?? ativas[0]?.id;

  const de = sp.de && isISODate(sp.de) ? sp.de : undefined;
  const ate = sp.ate && isISODate(sp.ate) ? sp.ate : undefined;

  return {
    bankAccountId,
    from: de ?? startOfMonth(monthOf(hoje)),
    to: ate ?? hoje,
    periodoInvalido: Boolean(de && ate && de > ate),
  };
}

/**
 * Query string com os filtros ativos.
 *
 * Todo link e todo formulário que navega dentro da Conciliação precisa carregar
 * isto: a tela usa searchParams também para paginação (`pt`) e para os pop-ups
 * (`editar`, `excluir`), e sem os filtros junto o saldo se redefine sozinho
 * quando o usuário apenas abre um pop-up.
 */
export function filtersToQuery(sp: ConciliacaoFilterParams): string {
  const params = new URLSearchParams();
  for (const chave of ["conta", "de", "ate"] as const) {
    const valor = sp[chave];
    if (valor) params.set(chave, valor);
  }
  const q = params.toString();
  return q ? `&${q}` : "";
}
