import { describe, expect, it } from "vitest";
import type { CostCenter } from "@/core/entities";
import { costCentersForScope } from "@/app/(app)/cadastros/_lib/cost-centers";

/**
 * Destino do centro de custo: filtra apenas o que aparece nos selects de
 * lançamento. Não mexe em títulos já vinculados — isso é regra da action de
 * edição, não deste filtro.
 */

const CO = "co_test";

function cc(over: Partial<CostCenter> & { id: string; code: string }): CostCenter {
  return {
    companyId: CO,
    name: `Centro ${over.code}`,
    active: true,
    scope: "both",
    ...over,
  };
}

const base: CostCenter[] = [
  cc({ id: "cc_3", code: "CC-03", scope: "receivable" }),
  cc({ id: "cc_1", code: "CC-01", scope: "payable" }),
  cc({ id: "cc_2", code: "CC-02", scope: "both" }),
  cc({ id: "cc_4", code: "CC-04", scope: "payable", active: false }),
];

describe("costCentersForScope", () => {
  it("a pagar: traz os do destino e os de ambos, ordenados por código", () => {
    const r = costCentersForScope(base, "payable");
    expect(r.map((c) => c.code)).toEqual(["CC-01", "CC-02"]);
  });

  it("a receber: traz os do destino e os de ambos", () => {
    const r = costCentersForScope(base, "receivable");
    expect(r.map((c) => c.code)).toEqual(["CC-02", "CC-03"]);
  });

  it("não oferece centro inativo em lançamento novo", () => {
    expect(costCentersForScope(base, "payable").some((c) => c.id === "cc_4")).toBe(false);
  });

  it('centro marcado só para um lado some do outro select', () => {
    expect(costCentersForScope(base, "payable").some((c) => c.id === "cc_3")).toBe(false);
    expect(costCentersForScope(base, "receivable").some((c) => c.id === "cc_1")).toBe(false);
  });

  it('"both" é o default de quem foi cadastrado antes do campo existir e aparece nos dois', () => {
    const antigo = cc({ id: "cc_old", code: "CC-00" });
    expect(antigo.scope).toBe("both");
    expect(costCentersForScope([antigo], "payable")).toHaveLength(1);
    expect(costCentersForScope([antigo], "receivable")).toHaveLength(1);
  });

  it("lista vazia não quebra", () => {
    expect(costCentersForScope([], "payable")).toEqual([]);
  });
});
