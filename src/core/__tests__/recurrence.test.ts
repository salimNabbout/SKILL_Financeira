import { describe, expect, it } from "vitest";
import type { RecurringTemplate } from "@/core/entities";
import { dueDateForMonth, shouldGenerateFor } from "@/core/recurrence";

function template(over: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: "rec_1",
    companyId: "co_1",
    kind: "payable",
    counterpartyId: "sup_1",
    description: "Aluguel",
    amountCents: 200_000,
    dueDay: 5,
    startDate: "2026-01-01",
    status: "active",
    createdBy: "usr_1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("dueDateForMonth", () => {
  it("usa o dueDay no mês pedido", () => {
    expect(dueDateForMonth(template({ dueDay: 5 }), "2026-03")).toBe("2026-03-05");
  });

  it("dia inexistente cai no último dia do mês (31 em fevereiro)", () => {
    expect(dueDateForMonth(template({ dueDay: 31 }), "2026-02")).toBe("2026-02-28");
  });

  it("dia 30 em fevereiro de ano bissexto cai em 29", () => {
    expect(dueDateForMonth(template({ dueDay: 30 }), "2028-02")).toBe("2028-02-29");
  });
});

describe("shouldGenerateFor", () => {
  it("gera no mês corrente quando ativa e dentro do período", () => {
    expect(shouldGenerateFor(template(), "2026-03-01")).toBe("2026-03");
  });

  it("não gera antes do startDate", () => {
    expect(shouldGenerateFor(template({ startDate: "2026-04-01" }), "2026-03-15")).toBeNull();
  });

  it("gera no mês do startDate mesmo que o startDate seja depois do dia 1", () => {
    expect(shouldGenerateFor(template({ startDate: "2026-03-10" }), "2026-03-15")).toBe("2026-03");
  });

  it("não gera depois do endDate", () => {
    expect(
      shouldGenerateFor(template({ endDate: "2026-02-28" }), "2026-03-01")
    ).toBeNull();
  });

  it("não gera quando pausada ou encerrada", () => {
    expect(shouldGenerateFor(template({ status: "paused" }), "2026-03-01")).toBeNull();
    expect(shouldGenerateFor(template({ status: "ended" }), "2026-03-01")).toBeNull();
  });

  it("endDate no mês corrente ainda gera (inclusive)", () => {
    expect(shouldGenerateFor(template({ endDate: "2026-03-31" }), "2026-03-01")).toBe("2026-03");
  });
});
