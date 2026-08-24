/**
 * Seleção de centros de custo por destino, compartilhada pelas telas de
 * lançamento. Função pura, sem dependência de Next/server.
 */

import type { CostCenter, CostCenterScope } from "@/core/entities";

/** Opção exibida no select de centro de custo. */
export interface CostCenterOption {
  id: string;
  code: string;
  name: string;
}

/**
 * Centros ATIVOS que servem ao destino pedido, ordenados por código.
 *
 * "both" atende os dois lados — é o default de quem foi cadastrado antes do
 * campo existir, e some da lista apenas quem foi marcado explicitamente para o
 * outro destino. Centros inativos ficam fora de lançamentos novos, mas os
 * títulos que já os referenciam continuam intactos.
 */
export function costCentersForScope(
  costCenters: CostCenter[],
  scope: Exclude<CostCenterScope, "both">
): CostCenterOption[] {
  return costCenters
    .filter((c) => c.active && (c.scope === scope || c.scope === "both"))
    .sort((a, b) => a.code.localeCompare(b.code, "pt-BR"))
    .map((c) => ({ id: c.id, code: c.code, name: c.name }));
}
