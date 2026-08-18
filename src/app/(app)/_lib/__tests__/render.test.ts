/**
 * Smoke tests de renderização (renderToStaticMarkup) dos componentes de
 * apresentação compartilhados — garantem que os SVGs e o meta do SkillResult
 * renderizam sem quebrar, inclusive nos casos vazios/erro.
 */

import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// O transform do vitest (esbuild) usa o runtime JSX clássico, que referencia o
// identificador global `React` — o Next usa o runtime automático, então os
// componentes não importam React. Suprimos o global apenas no teste.
(globalThis as { React?: typeof React }).React = React;
import type { SkillResult } from "@/core/types";
import { BalanceLineChart, InOutBarChart } from "../charts";
import { SkillResultMeta, SkillUnavailableCard } from "../result-meta";

function fakeResult(overrides: Partial<SkillResult<unknown>> = {}): SkillResult<unknown> {
  return {
    skill: "tesouraria_fluxo_caixa",
    status: "success",
    confidence: 1,
    data: {},
    alerts: [],
    pending_items: [],
    assumptions: [],
    requires_human_approval: false,
    audit: { execution_id: "exec_1", timestamp: "2026-08-18T15:00:00.000Z", data_sources: [] },
    ...overrides,
  };
}

describe("InOutBarChart", () => {
  it("renderiza SVG com legenda, barras e tooltips", () => {
    const html = renderToStaticMarkup(
      createElement(InOutBarChart, {
        groups: [
          { label: "Sem 1", title: "18/08/2026 a 24/08/2026", inCents: 500_000, outCents: 300_000 },
          { label: "Sem 2", inCents: 0, outCents: 120_000 },
        ],
      })
    );
    expect(html).toContain("<svg");
    expect(html).toContain("Entradas");
    expect(html).toContain("Saídas");
    expect(html).toContain("Sem 1");
    expect(html).toContain("<title>");
    expect(html).toContain("var(--ok)");
    expect(html).toContain("var(--crit)");
  });

  it("caso vazio não quebra", () => {
    const html = renderToStaticMarkup(createElement(InOutBarChart, { groups: [] }));
    expect(html).toContain("Sem dados");
  });
});

describe("BalanceLineChart", () => {
  it("renderiza linha, marcador de menor saldo e eixo com zero quando há negativo", () => {
    const html = renderToStaticMarkup(
      createElement(BalanceLineChart, {
        points: [
          { date: "2026-08-18", valueCents: 100_000 },
          { date: "2026-08-19", valueCents: -50_000 },
          { date: "2026-08-20", valueCents: 20_000 },
        ],
      })
    );
    expect(html).toContain("<svg");
    expect(html).toContain("Menor saldo");
    expect(html).toContain("Saldo final");
    expect(html).toContain("var(--brand)");
    expect(html).toContain("18/08");
  });

  it("caso vazio não quebra", () => {
    const html = renderToStaticMarkup(createElement(BalanceLineChart, { points: [] }));
    expect(html).toContain("Sem dados");
  });
});

describe("SkillResultMeta", () => {
  it("exibe alertas, suposições e fontes", () => {
    const html = renderToStaticMarkup(
      createElement(SkillResultMeta, {
        result: fakeResult({
          alerts: [{ severity: "warning", code: "x", message: "Saldo abaixo do mínimo." }],
          assumptions: ["Projeção considera títulos em aberto."],
          audit: {
            execution_id: "exec_1",
            timestamp: "2026-08-18T15:00:00.000Z",
            data_sources: ["payables", "receivables"],
          },
        }),
      })
    );
    expect(html).toContain("Saldo abaixo do mínimo.");
    expect(html).toContain("Suposições");
    expect(html).toContain("payables, receivables");
  });

  it("sem conteúdo, não renderiza nada", () => {
    expect(renderToStaticMarkup(createElement(SkillResultMeta, { result: fakeResult() }))).toBe("");
  });
});

describe("SkillUnavailableCard", () => {
  it("exibe mensagem padrão e detalhe do alerta", () => {
    const html = renderToStaticMarkup(
      createElement(SkillUnavailableCard, {
        title: "DRE",
        result: fakeResult({
          status: "error",
          data: null,
          alerts: [{ severity: "critical", code: "e", message: "Falha X." }],
        }),
      })
    );
    expect(html).toContain("Skill em implementação");
    expect(html).toContain("Falha X.");
  });
});
