import { describe, expect, it } from "vitest";
import type { Payable } from "@/core/entities";
import {
  derivePayableSituation,
  hasPartialPayment,
} from "@/lib/payable-situation";

const TODAY = "2026-08-25";

/** Título mínimo para a derivação (só os campos que a função lê). */
function payable(over: Partial<Pick<Payable, "status" | "dueDate" | "paidCents" | "amountCents">>) {
  return {
    status: "open" as Payable["status"],
    dueDate: TODAY,
    paidCents: 0,
    amountCents: 10_000,
    ...over,
  };
}

describe("derivePayableSituation", () => {
  it("vencimento amanhã, em aberto → A Vencer", () => {
    expect(derivePayableSituation(payable({ dueDate: "2026-08-26" }), TODAY)).toBe("A Vencer");
  });

  it("vencimento hoje, em aberto → Hoje", () => {
    expect(derivePayableSituation(payable({ dueDate: TODAY }), TODAY)).toBe("Hoje");
  });

  it("vencimento ontem, em aberto → Atrasado", () => {
    expect(derivePayableSituation(payable({ dueDate: "2026-08-24" }), TODAY)).toBe("Atrasado");
  });

  it("pago antes do vencimento → Pago", () => {
    expect(
      derivePayableSituation(payable({ status: "paid", dueDate: "2026-08-30" }), TODAY, "2026-08-25")
    ).toBe("Pago");
  });

  it("pago no dia do vencimento → Pago no Vencimento (não é atraso)", () => {
    expect(
      derivePayableSituation(payable({ status: "paid", dueDate: "2026-08-25" }), TODAY, "2026-08-25")
    ).toBe("Pago no Vencimento");
  });

  it("pago um dia após o vencimento → Pago Atrasado", () => {
    expect(
      derivePayableSituation(payable({ status: "paid", dueDate: "2026-08-24" }), TODAY, "2026-08-25")
    ).toBe("Pago Atrasado");
  });

  it("pago sem data de pagamento conhecida → Pago (sem afirmar atraso)", () => {
    expect(
      derivePayableSituation(payable({ status: "paid", dueDate: "2026-08-01" }), TODAY)
    ).toBe("Pago");
  });

  it("cancelado com vencimento passado → Cancelado (precedência máxima)", () => {
    expect(
      derivePayableSituation(payable({ status: "canceled", dueDate: "2026-01-01" }), TODAY)
    ).toBe("Cancelado");
  });

  it("Q2: parcialmente pago com vencimento passado → Atrasado", () => {
    expect(
      derivePayableSituation(
        payable({ status: "partially_paid", dueDate: "2026-08-24", paidCents: 4_000 }),
        TODAY
      )
    ).toBe("Atrasado");
  });

  it("agendado com vencimento futuro → A Vencer", () => {
    expect(
      derivePayableSituation(payable({ status: "scheduled", dueDate: "2026-09-10" }), TODAY)
    ).toBe("A Vencer");
  });
});

describe("hasPartialPayment", () => {
  it("true quando há baixa parcial e o título não está pago/cancelado", () => {
    expect(hasPartialPayment({ status: "partially_paid", paidCents: 4_000 })).toBe(true);
    expect(hasPartialPayment({ status: "open", paidCents: 0 })).toBe(false);
    expect(hasPartialPayment({ status: "paid", paidCents: 10_000 })).toBe(false);
    expect(hasPartialPayment({ status: "canceled", paidCents: 3_000 })).toBe(false);
  });
});
