import { describe, expect, it } from "vitest";
import type { Receivable } from "@/core/entities";
import {
  deriveReceivableSituation,
  hasPartialReceipt,
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
