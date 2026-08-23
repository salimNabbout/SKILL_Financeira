import { describe, expect, it } from "vitest";
import type { Payable, Receivable } from "@/core/entities";
import { payableRemainingCents, receivableRemainingCents } from "@/core/money";

function payable(amountCents: number, paidCents: number): Payable {
  return {
    id: "p1",
    companyId: "co",
    supplierId: "sup",
    description: "T",
    issueDate: "2026-01-01",
    dueDate: "2026-01-10",
    amountCents,
    paidCents,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: "p1",
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function receivable(amountCents: number, receivedCents: number): Receivable {
  return {
    id: "r1",
    companyId: "co",
    customerId: "cus",
    description: "T",
    issueDate: "2026-01-01",
    dueDate: "2026-01-10",
    amountCents,
    receivedCents,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: "r1",
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("payableRemainingCents", () => {
  it("sem pagamento → saldo = valor total", () => {
    expect(payableRemainingCents(payable(100_00, 0))).toBe(100_00);
  });
  it("parcialmente pago → saldo = diferença", () => {
    expect(payableRemainingCents(payable(100_00, 40_00))).toBe(60_00);
  });
  it("totalmente pago → saldo = 0", () => {
    expect(payableRemainingCents(payable(100_00, 100_00))).toBe(0);
  });
  it("pago a maior (paidCents > amountCents) → saldo = 0, nunca negativo", () => {
    expect(payableRemainingCents(payable(100_00, 130_00))).toBe(0);
  });
});

describe("receivableRemainingCents", () => {
  it("sem recebimento → saldo = valor total", () => {
    expect(receivableRemainingCents(receivable(100_00, 0))).toBe(100_00);
  });
  it("parcialmente recebido → saldo = diferença", () => {
    expect(receivableRemainingCents(receivable(100_00, 40_00))).toBe(60_00);
  });
  it("totalmente recebido → saldo = 0", () => {
    expect(receivableRemainingCents(receivable(100_00, 100_00))).toBe(0);
  });
  it("recebido a maior (receivedCents > amountCents) → saldo = 0, nunca negativo", () => {
    expect(receivableRemainingCents(receivable(100_00, 130_00))).toBe(0);
  });
  it("usa receivedCents (não paidCents): título com receivedCents parcial", () => {
    // Garante que o helper de receber olha o campo certo — Receivable não tem paidCents.
    const r = receivable(200_00, 50_00);
    expect(receivableRemainingCents(r)).toBe(150_00);
  });
});
