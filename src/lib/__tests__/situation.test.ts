import { describe, expect, it } from "vitest";
import { deriveSituation } from "@/lib/situation";

const TODAY = "2026-08-25";

describe("deriveSituation (genérica, comum a pagar/receber)", () => {
  it("cancelado tem precedência máxima", () => {
    expect(
      deriveSituation({ status: "canceled", dueDate: "2026-01-01", remainingCents: 0 }, TODAY)
    ).toBe("cancelado");
  });

  it("quitado após o vencimento → quitado_atraso", () => {
    expect(
      deriveSituation(
        { status: "settled", dueDate: "2026-08-24", remainingCents: 0, settledAt: "2026-08-25" },
        TODAY
      )
    ).toBe("quitado_atraso");
  });

  it("quitado no dia do vencimento → quitado (não é atraso)", () => {
    expect(
      deriveSituation(
        { status: "settled", dueDate: "2026-08-25", remainingCents: 0, settledAt: "2026-08-25" },
        TODAY
      )
    ).toBe("quitado");
  });

  it("quitado sem data conhecida → quitado", () => {
    expect(
      deriveSituation({ status: "settled", dueDate: "2026-01-01", remainingCents: 0 }, TODAY)
    ).toBe("quitado");
  });

  it("em aberto: vencido → atrasado; hoje → hoje; futuro → a_vencer", () => {
    expect(
      deriveSituation({ status: "open", dueDate: "2026-08-24", remainingCents: 500 }, TODAY)
    ).toBe("atrasado");
    expect(
      deriveSituation({ status: "open", dueDate: "2026-08-25", remainingCents: 500 }, TODAY)
    ).toBe("hoje");
    expect(
      deriveSituation({ status: "open", dueDate: "2026-08-26", remainingCents: 500 }, TODAY)
    ).toBe("a_vencer");
  });
});
