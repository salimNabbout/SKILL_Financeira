/**
 * Auditoria de fórmulas — Dashboard (cálculos feitos na própria página).
 *
 * Os quatro números que a página deriva da série diária da projeção
 * (A pagar 7 dias, A receber 7 dias e as 4 semanas do gráfico) e o tom do
 * card "Saldo disponível" são funções puras em ../dashboard-metrics.ts.
 * Casos cobertos: base vazia, limites inclusivos da janela, vencidos (que a
 * projeção coloca em "hoje"), virada de mês e de ano, centavos ímpares.
 */

import { describe, expect, it } from "vitest";
import {
  availableTone,
  buildWeekGroups,
  DASHBOARD_FORMULAS,
  sumFlowsThrough,
  type DailyPointView,
} from "../dashboard-metrics";

const point = (date: string, inCents: number, outCents: number): DailyPointView => ({
  date,
  inCents,
  outCents,
  balanceCents: 0,
});

describe("Dashboard — A pagar / A receber (7 dias)", () => {
  it("base vazia: zeros e limite = hoje + 7", () => {
    const r = sumFlowsThrough([], "2026-09-17");
    expect(r).toEqual({ inCents: 0, outCents: 0, limit: "2026-09-24" });
  });

  it("janela inclusiva nas duas pontas: hoje e hoje+7 entram, hoje+8 não", () => {
    const daily = [
      point("2026-09-17", 100, 1_001), // hoje (vencidos caem aqui)
      point("2026-09-24", 200, 2_002), // hoje + 7 (último dia da janela)
      point("2026-09-25", 400, 4_004), // hoje + 8 (fora)
    ];
    const r = sumFlowsThrough(daily, "2026-09-17");
    expect(r.inCents).toBe(300);
    expect(r.outCents).toBe(3_003);
    expect(r.limit).toBe("2026-09-24");
  });

  it("virada de mês e de ano: 30/12 + 7 = 06/01 do ano seguinte", () => {
    const daily = [
      point("2026-12-30", 1, 10),
      point("2026-12-31", 2, 20),
      point("2027-01-06", 4, 40),
      point("2027-01-07", 8, 80), // fora
    ];
    const r = sumFlowsThrough(daily, "2026-12-30");
    expect(r).toEqual({ inCents: 7, outCents: 70, limit: "2027-01-06" });
  });

  it("centavos ímpares somam sem arredondar (aritmética inteira)", () => {
    const daily = [point("2026-09-17", 3, 7), point("2026-09-18", 5, 11)];
    expect(sumFlowsThrough(daily, "2026-09-17")).toEqual({
      inCents: 8,
      outCents: 18,
      limit: "2026-09-24",
    });
  });

  it("pontos sem data ou sem valores são ignorados (contrato defensivo)", () => {
    const daily = [{ inCents: 5, outCents: 5 }, { date: "2026-09-18" }] as DailyPointView[];
    expect(sumFlowsThrough(daily, "2026-09-17")).toEqual({
      inCents: 0,
      outCents: 0,
      limit: "2026-09-24",
    });
  });
});

describe("Dashboard — gráfico Entradas × saídas (4 semanas)", () => {
  it("base vazia: 4 semanas zeradas com rótulos e intervalos corretos", () => {
    const groups = buildWeekGroups([], "2026-09-17");
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.label)).toEqual(["Sem 1", "Sem 2", "Sem 3", "Sem 4"]);
    expect(groups[0].title).toBe("17/09/2026 a 23/09/2026");
    expect(groups[3].title).toBe("08/10/2026 a 14/10/2026");
    expect(groups.every((g) => g.inCents === 0 && g.outCents === 0)).toBe(true);
  });

  it("semanas de 7 dias contíguas, inclusivas, cobrindo hoje..hoje+27; hoje+28 fica fora", () => {
    const daily = [
      point("2026-09-17", 1, 0), // sem 1 (início)
      point("2026-09-23", 2, 0), // sem 1 (fim)
      point("2026-09-24", 4, 0), // sem 2 (início)
      point("2026-10-07", 8, 0), // sem 3 (fim)
      point("2026-10-14", 16, 0), // sem 4 (fim)
      point("2026-10-15", 32, 0), // fora (hoje + 28)
    ];
    const groups = buildWeekGroups(daily, "2026-09-17");
    expect(groups.map((g) => g.inCents)).toEqual([3, 4, 8, 16]);
  });

  it("vencidos: a projeção os coloca em 'hoje', então caem na semana 1", () => {
    // A série diária já vem com o vencido consolidado em hoje (regra da skill).
    const daily = [point("2026-09-17", 0, 150_000)];
    const groups = buildWeekGroups(daily, "2026-09-17");
    expect(groups[0].outCents).toBe(150_000);
    expect(groups[1].outCents).toBe(0);
  });

  it("virada de ano: semanas cruzam 31/12 sem perder dias", () => {
    const daily = [
      point("2026-12-31", 0, 10),
      point("2027-01-01", 0, 20),
      point("2027-01-24", 0, 40), // hoje(28/12)+27 = 24/01 → sem 4
      point("2027-01-25", 0, 80), // fora
    ];
    const groups = buildWeekGroups(daily, "2026-12-28");
    expect(groups[0].title).toBe("28/12/2026 a 03/01/2027");
    expect(groups[0].outCents).toBe(30);
    expect(groups[3].outCents).toBe(40);
  });

  it("A pagar (7 dias) é igual à semana 1 mais o dia hoje+7 (as janelas diferem em 1 dia)", () => {
    const daily = [point("2026-09-17", 0, 100), point("2026-09-24", 0, 1_000)];
    const seven = sumFlowsThrough(daily, "2026-09-17");
    const groups = buildWeekGroups(daily, "2026-09-17");
    expect(groups[0].outCents).toBe(100);
    expect(seven.outCents).toBe(1_100);
  });
});

describe("Dashboard — tom do card Saldo disponível", () => {
  it("negativo = crítico; abaixo do caixa mínimo = atenção; senão ok; sem valor = neutro", () => {
    expect(availableTone(-1, 100_000)).toBe("crit");
    expect(availableTone(0, 100_000)).toBe("warn");
    expect(availableTone(99_999, 100_000)).toBe("warn");
    expect(availableTone(100_000, 100_000)).toBe("ok");
    expect(availableTone(undefined, 100_000)).toBe("neutral");
  });
});

describe("Dashboard — fórmulas declaradas", () => {
  it("as fórmulas dos quatro cálculos da página estão documentadas", () => {
    expect(DASHBOARD_FORMULAS.payables7d).toContain("hoje + 7");
    expect(DASHBOARD_FORMULAS.receivables7d).toContain("hoje + 7");
    expect(DASHBOARD_FORMULAS.weeks4).toContain("4 semanas");
  });
});
