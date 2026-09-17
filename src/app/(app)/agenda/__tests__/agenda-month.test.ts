/**
 * Auditoria de fórmulas — Agenda (AGD-01..AGD-10). A página não tinha nenhum
 * teste; o cálculo foi extraído para _lib/agenda-month.ts sem mudar o
 * comportamento. Casos: base vazia, cancelado, pagamento parcial, pago a
 * maior, vencido (fica no dia do vencimento), fevereiro/bissexto, virada de
 * ano no seletor, título fora do mês (defensivo), ordenação do detalhamento
 * e identidade "totais do mês = Σ dias".
 */

import { describe, expect, it } from "vitest";
import type { Payable, Receivable } from "@/core/entities";
import { buildAgendaMonth, resolveAgendaMonth } from "../_lib/agenda-month";

const NAMES = { supplier: (id: string) => `F:${id}`, customer: (id: string) => `C:${id}` };

function payable(over: Partial<Payable> & { id: string; dueDate: string; amountCents: number }): Payable {
  return {
    companyId: "co_1",
    supplierId: "sup_1",
    description: over.id,
    issueDate: "2026-01-01",
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: over.id,
    createdBy: "usr",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function receivable(
  over: Partial<Receivable> & { id: string; dueDate: string; amountCents: number }
): Receivable {
  return {
    companyId: "co_1",
    customerId: "cus_1",
    description: over.id,
    issueDate: "2026-01-01",
    receivedCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: over.id,
    createdBy: "usr",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("Agenda — mês exibido", () => {
  it("sem parâmetros usa o mês de hoje; parâmetros válidos são respeitados; inválidos caem em hoje", () => {
    expect(resolveAgendaMonth("2026-09-17")).toEqual({ month: "2026-09", anoNum: 2026, mesNum: 9 });
    expect(resolveAgendaMonth("2026-09-17", "2027", "1")).toEqual({ month: "2027-01", anoNum: 2027, mesNum: 1 });
    expect(resolveAgendaMonth("2026-09-17", "abc", "13").month).toBe("2026-09");
    expect(resolveAgendaMonth("2026-12-31", undefined, "0").month).toBe("2026-12");
  });
});

describe("Agenda — base vazia", () => {
  it("sem títulos: 30 células zeradas, totais zero e sem movimento", () => {
    const a = buildAgendaMonth("2026-09", [], [], NAMES);
    expect(a.daysInMonth).toBe(30);
    expect(a.firstWeekday).toBe(2); // 01/09/2026 é terça-feira
    expect(a.cells).toHaveLength(30);
    expect(a.monthInCents).toBe(0);
    expect(a.monthOutCents).toBe(0);
    expect(a.monthNetCents).toBe(0);
    expect(a.hasMovement).toBe(false);
  });
});

describe("Agenda — status e saldos", () => {
  it("cancelado, pago e recebido ficam fora; parciais entram pelo saldo restante; pago a maior vira 0", () => {
    const a = buildAgendaMonth(
      "2026-09",
      [
        payable({ id: "p_open", dueDate: "2026-09-10", amountCents: 1_000 }),
        payable({ id: "p_part", dueDate: "2026-09-10", amountCents: 1_000, paidCents: 300, status: "partially_paid" }),
        payable({ id: "p_sched", dueDate: "2026-09-11", amountCents: 500, status: "scheduled" }),
        payable({ id: "p_paid", dueDate: "2026-09-10", amountCents: 9_000, paidCents: 9_000, status: "paid" }),
        payable({ id: "p_cancel", dueDate: "2026-09-10", amountCents: 9_000, status: "canceled", canceledAt: "2026-09-01T12:00:00.000Z" }),
        payable({ id: "p_over", dueDate: "2026-09-12", amountCents: 100, paidCents: 150, status: "partially_paid" }),
      ],
      [
        receivable({ id: "r_open", dueDate: "2026-09-10", amountCents: 4_000 }),
        receivable({ id: "r_part", dueDate: "2026-09-15", amountCents: 4_000, receivedCents: 2_500, status: "partially_received" }),
        receivable({ id: "r_recv", dueDate: "2026-09-10", amountCents: 9_000, receivedCents: 9_000, status: "received" }),
        receivable({ id: "r_cancel", dueDate: "2026-09-10", amountCents: 9_000, status: "canceled" }),
      ],
      NAMES
    );
    const d10 = a.cells[9];
    expect(d10.outCents).toBe(1_000 + 700);
    expect(d10.inCents).toBe(4_000);
    expect(d10.netCents).toBe(4_000 - 1_700);
    expect(d10.payables.map((p) => p.id)).toEqual(["p_open", "p_part"]);
    expect(a.cells[10].outCents).toBe(500);
    expect(a.cells[11].outCents).toBe(0); // pago a maior: saldo restante nunca negativo
    expect(a.cells[11].payables).toHaveLength(1);
    expect(a.cells[14].inCents).toBe(1_500);

    expect(a.monthOutCents).toBe(1_000 + 700 + 500 + 0);
    expect(a.monthInCents).toBe(4_000 + 1_500);
    expect(a.monthNetCents).toBe(5_500 - 2_200);
    expect(a.hasMovement).toBe(true);
    // Identidade: totais do mês = Σ dos dias.
    expect(a.cells.reduce((s, c) => s + c.outCents, 0)).toBe(a.monthOutCents);
    expect(a.cells.reduce((s, c) => s + c.inCents, 0)).toBe(a.monthInCents);
    // Nomes das contrapartes resolvidos.
    expect(d10.payables[0].party).toBe("F:sup_1");
    expect(d10.receivables[0].party).toBe("C:cus_1");
  });

  it("vencido e ainda em aberto fica no DIA DO VENCIMENTO (não é deslocado para hoje)", () => {
    const a = buildAgendaMonth(
      "2026-09",
      [payable({ id: "p_old", dueDate: "2026-09-02", amountCents: 700 })],
      [],
      NAMES
    );
    expect(a.cells[1].outCents).toBe(700);
    expect(a.cells.filter((c) => c.outCents > 0)).toHaveLength(1);
  });

  it("título com vencimento fora do mês é ignorado (defensivo), mesmo que venha na consulta", () => {
    const a = buildAgendaMonth(
      "2026-09",
      [payable({ id: "p_out", dueDate: "2026-10-01", amountCents: 700 })],
      [receivable({ id: "r_out", dueDate: "2026-08-31", amountCents: 900 })],
      NAMES
    );
    expect(a.monthOutCents).toBe(0);
    expect(a.monthInCents).toBe(0);
    expect(a.hasMovement).toBe(false);
  });
});

describe("Agenda — calendário", () => {
  it("fevereiro de 2028 (bissexto) tem 29 dias; fevereiro de 2026 tem 28", () => {
    expect(buildAgendaMonth("2028-02", [], [], NAMES).daysInMonth).toBe(29);
    expect(buildAgendaMonth("2026-02", [], [], NAMES).daysInMonth).toBe(28);
  });

  it("último dia do mês recebe o título do dia 31", () => {
    const a = buildAgendaMonth(
      "2026-12",
      [payable({ id: "p31", dueDate: "2026-12-31", amountCents: 31 })],
      [],
      NAMES
    );
    expect(a.cells[30].outCents).toBe(31);
    expect(a.firstWeekday).toBe(2); // 01/12/2026 é terça-feira
  });

  it("detalhamento ordena por vencimento e desempata por id", () => {
    const a = buildAgendaMonth(
      "2026-09",
      [
        payable({ id: "b", dueDate: "2026-09-20", amountCents: 1 }),
        payable({ id: "a", dueDate: "2026-09-20", amountCents: 1 }),
        payable({ id: "z", dueDate: "2026-09-05", amountCents: 1 }),
      ],
      [],
      NAMES
    );
    expect(a.monthPayables.map((p) => p.id)).toEqual(["z", "a", "b"]);
  });
});
