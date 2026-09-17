import { describe, expect, it } from "vitest";
import type { Payable } from "@/core/entities";
import { resolveDuePeriod, sumPaidInDuePeriod } from "../_lib/period-totals";

function payable(over: Partial<Payable> & { id: string; dueDate: string; amountCents: number; paidCents: number }): Payable {
  return {
    companyId: "co_1",
    supplierId: "sup_1",
    description: over.id,
    issueDate: "2026-01-01",
    currency: "BRL",
    status: over.paidCents >= over.amountCents ? "paid" : over.paidCents > 0 ? "partially_paid" : "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: over.id,
    createdBy: "usr",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("Filtros de Contas a pagar — período dos totalizadores", () => {
  it("caixas De/Até limpas: mês corrente completo, respeitando 28/29/30/31 dias", () => {
    expect(resolveDuePeriod({}, "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28", origin: "mes-corrente" });
    expect(resolveDuePeriod({}, "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29", origin: "mes-corrente" });
    expect(resolveDuePeriod({}, "2026-04-30")).toEqual({ from: "2026-04-01", to: "2026-04-30", origin: "mes-corrente" });
    expect(resolveDuePeriod({}, "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-01-31", origin: "mes-corrente" });
  });

  it("De e Até preenchidos: exatamente o intervalo informado", () => {
    expect(resolveDuePeriod({ de: "2026-09-05", ate: "2026-09-12" }, "2026-09-17")).toEqual({ from: "2026-09-05", to: "2026-09-12", origin: "de-ate" });
  });

  it("só De: até o fim do mês da data; só Até: desde o início do mês da data", () => {
    expect(resolveDuePeriod({ de: "2026-09-10" }, "2026-01-01")).toEqual({ from: "2026-09-10", to: "2026-09-30", origin: "de" });
    expect(resolveDuePeriod({ ate: "2026-02-10" }, "2026-01-01")).toEqual({ from: "2026-02-01", to: "2026-02-10", origin: "ate" });
  });

  it("Ano + Mês: o mês escolhido completo; só Ano: o ano inteiro", () => {
    expect(resolveDuePeriod({ ano: 2026, mes: 6 }, "2026-09-17")).toEqual({ from: "2026-06-01", to: "2026-06-30", origin: "mes" });
    expect(resolveDuePeriod({ ano: 2025 }, "2026-09-17")).toEqual({ from: "2025-01-01", to: "2025-12-31", origin: "ano" });
  });

  it("De/Até têm precedência sobre Ano/Mês", () => {
    expect(resolveDuePeriod({ de: "2026-03-01", ate: "2026-03-31", ano: 2026, mes: 9 }, "2026-09-17").origin).toBe("de-ate");
  });
});

describe("Filtros de Contas a pagar — Total Pago / Custo FIXO / Custo VARIÁVEL", () => {
  const titulos = [
    payable({ id: "fixo_pago", dueDate: "2026-09-01", amountCents: 1_000, paidCents: 1_000, costClassification: "fixed" }),
    payable({ id: "var_parcial", dueDate: "2026-09-15", amountCents: 2_000, paidCents: 700, costClassification: "variable" }),
    payable({ id: "sem_classe_pago", dueDate: "2026-09-30", amountCents: 300, paidCents: 300 }),
    payable({ id: "fixo_aberto", dueDate: "2026-09-20", amountCents: 5_000, paidCents: 0, costClassification: "fixed" }),
    payable({ id: "cancelado", dueDate: "2026-09-10", amountCents: 9_999, paidCents: 9_999, costClassification: "fixed", status: "canceled" }),
    payable({ id: "fora_antes", dueDate: "2026-08-31", amountCents: 100, paidCents: 100, costClassification: "fixed" }),
    payable({ id: "fora_depois", dueDate: "2026-10-01", amountCents: 100, paidCents: 100, costClassification: "variable" }),
  ];

  it("soma o VALOR PAGO dos títulos com vencimento no período (inclusivo), sem cancelados; parcial conta o pago", () => {
    const t = sumPaidInDuePeriod(titulos, resolveDuePeriod({}, "2026-09-17"));
    expect(t).toEqual({ paidCents: 2_000, fixedCents: 1_000, variableCents: 700, unclassifiedCents: 300, titulos: 4 });
    expect(t.fixedCents + t.variableCents + t.unclassifiedCents).toBe(t.paidCents);
  });

  it("sub-período por De/Até recorta pelo vencimento", () => {
    const t = sumPaidInDuePeriod(titulos, resolveDuePeriod({ de: "2026-09-10", ate: "2026-09-20" }, "2026-09-17"));
    expect(t).toEqual({ paidCents: 700, fixedCents: 0, variableCents: 700, unclassifiedCents: 0, titulos: 2 });
  });

  it("base vazia e período sem títulos: zeros", () => {
    expect(sumPaidInDuePeriod([], resolveDuePeriod({}, "2026-09-17")).paidCents).toBe(0);
    expect(sumPaidInDuePeriod(titulos, resolveDuePeriod({ ano: 2020, mes: 1 }, "2026-09-17"))).toEqual({
      paidCents: 0,
      fixedCents: 0,
      variableCents: 0,
      unclassifiedCents: 0,
      titulos: 0,
    });
  });
});
