import { describe, expect, it } from "vitest";
import type { Receivable } from "@/core/entities";
import {
  deriveReceivableSituation,
  hasPartialReceipt,
  isSettledSituation,
} from "@/lib/receivable-situation";

const TODAY = "2026-08-25";

function receivable(
  over: Partial<Pick<Receivable, "status" | "dueDate" | "receivedCents" | "amountCents">>
) {
  return {
    status: "open" as Receivable["status"],
    dueDate: TODAY,
    receivedCents: 0,
    amountCents: 10_000,
    ...over,
  };
}

describe("deriveReceivableSituation", () => {
  it("vencimento amanhã, em aberto → A Vencer", () => {
    expect(deriveReceivableSituation(receivable({ dueDate: "2026-08-26" }), TODAY)).toBe("A Vencer");
  });

  it("vencimento hoje, em aberto → Hoje", () => {
    expect(deriveReceivableSituation(receivable({ dueDate: TODAY }), TODAY)).toBe("Hoje");
  });

  it("vencimento ontem, em aberto → Atrasado", () => {
    expect(deriveReceivableSituation(receivable({ dueDate: "2026-08-24" }), TODAY)).toBe("Atrasado");
  });

  it("recebido no dia do vencimento → Recebido no Vencimento (não é atraso)", () => {
    expect(
      deriveReceivableSituation(
        receivable({ status: "received", dueDate: "2026-08-25" }),
        TODAY,
        "2026-08-25"
      )
    ).toBe("Recebido no Vencimento");
  });

  it("recebido antes do vencimento → Recebido", () => {
    expect(
      deriveReceivableSituation(
        receivable({ status: "received", dueDate: "2026-08-30" }),
        TODAY,
        "2026-08-25"
      )
    ).toBe("Recebido");
  });

  it("recebido um dia após o vencimento → Recebido em Atraso", () => {
    expect(
      deriveReceivableSituation(
        receivable({ status: "received", dueDate: "2026-08-24" }),
        TODAY,
        "2026-08-25"
      )
    ).toBe("Recebido em Atraso");
  });

  it("cancelado com vencimento passado → Cancelado (precedência máxima)", () => {
    expect(
      deriveReceivableSituation(
        receivable({ status: "canceled", dueDate: "2026-01-01" }),
        TODAY
      )
    ).toBe("Cancelado");
  });

  it("parcialmente recebido com vencimento passado → Atrasado (mesmo critério de CAP)", () => {
    expect(
      deriveReceivableSituation(
        receivable({ status: "partially_received", dueDate: "2026-08-24", receivedCents: 4_000 }),
        TODAY
      )
    ).toBe("Atrasado");
  });
});

describe("hasPartialReceipt", () => {
  it("true quando há baixa parcial e o título não está recebido/cancelado", () => {
    expect(hasPartialReceipt({ status: "partially_received", receivedCents: 4_000 })).toBe(true);
    expect(hasPartialReceipt({ status: "open", receivedCents: 0 })).toBe(false);
    expect(hasPartialReceipt({ status: "received", receivedCents: 10_000 })).toBe(false);
    expect(hasPartialReceipt({ status: "canceled", receivedCents: 3_000 })).toBe(false);
  });
});

describe("isSettledSituation", () => {
  it("true só para as três quitações (Recebido, Recebido no Vencimento, Recebido em Atraso)", () => {
    expect(isSettledSituation("Recebido")).toBe(true);
    expect(isSettledSituation("Recebido no Vencimento")).toBe(true);
    expect(isSettledSituation("Recebido em Atraso")).toBe(true);
    expect(isSettledSituation("A Vencer")).toBe(false);
    expect(isSettledSituation("Hoje")).toBe(false);
    expect(isSettledSituation("Atrasado")).toBe(false);
    expect(isSettledSituation("Cancelado")).toBe(false);
  });

  it("coincide com deriveReceivableSituation: todo título recebido é quitado, qualquer que seja a data", () => {
    const recebido = receivable({ status: "received", receivedCents: 10_000 });
    for (const receivedAt of ["2026-08-20", TODAY, "2026-08-30"]) {
      expect(isSettledSituation(deriveReceivableSituation(recebido, TODAY, receivedAt))).toBe(true);
    }
    expect(isSettledSituation(deriveReceivableSituation(receivable({}), TODAY))).toBe(false);
    expect(isSettledSituation(deriveReceivableSituation(receivable({ status: "canceled" }), TODAY))).toBe(false);
  });
});
