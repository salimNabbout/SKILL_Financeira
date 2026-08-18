import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  isISODate,
  monthsBetween,
  todayInTz,
} from "../dates";

describe("dates", () => {
  it("valida ISODate", () => {
    expect(isISODate("2026-02-28")).toBe(true);
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("28/02/2026")).toBe(false);
  });

  it("calcula hoje no fuso de São Paulo (UTC-3)", () => {
    // 01:30 UTC do dia 19 ainda é dia 18 em São Paulo
    expect(todayInTz(new Date("2026-08-19T01:30:00Z"), "America/Sao_Paulo")).toBe("2026-08-18");
    expect(todayInTz(new Date("2026-08-19T12:00:00Z"), "America/Sao_Paulo")).toBe("2026-08-19");
  });

  it("soma dias e meses respeitando fim de mês", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("diffDays e endOfMonth", () => {
    expect(diffDays("2026-08-01", "2026-08-18")).toBe(17);
    expect(endOfMonth("2026-02")).toBe("2026-02-28");
    expect(endOfMonth("2024-02")).toBe("2024-02-29");
  });

  it("monthsBetween inclusivo", () => {
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});
