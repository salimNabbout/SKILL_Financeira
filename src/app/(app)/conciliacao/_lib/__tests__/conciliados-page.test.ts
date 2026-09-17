import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CONCILIADOS_POR_PAGINA, conciliadosPage } from "../conciliados-page";

// O transform do vitest usa o runtime JSX clássico (global `React`); o Next usa
// o automático. Suprimos o global só no teste, como em _lib/__tests__/render.test.ts.
(globalThis as { React?: typeof React }).React = React;

// next/link precisa do roteador do App Router; fora dele vira um <a> simples.
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
      h("a", { href: props.href, className: props.className }, props.children),
  };
});

import { Pager } from "@/app/(app)/_lib/pager";

describe("Conciliação — paginação do card Conciliados (?pc=)", () => {
  it("30 por página; sem parâmetro é a primeira página", () => {
    expect(CONCILIADOS_POR_PAGINA).toBe(30);
    expect(conciliadosPage(292, undefined)).toEqual({ total: 292, offset: 0, limit: 30 });
    expect(conciliadosPage(292, "1")).toEqual({ total: 292, offset: 0, limit: 30 });
  });

  it("página N começa em (N-1)*30 — os 292 conciliados cabem em 10 páginas", () => {
    expect(conciliadosPage(292, "2").offset).toBe(30);
    expect(conciliadosPage(292, "10").offset).toBe(270);
  });

  it("página além da última cai na última (nunca uma tabela vazia)", () => {
    expect(conciliadosPage(292, "11").offset).toBe(270);
    expect(conciliadosPage(292, "999").offset).toBe(270);
    expect(conciliadosPage(30, "2").offset).toBe(0);
  });

  it("parâmetro inválido (zero, negativo, texto, vazio) cai na primeira página", () => {
    for (const pc of ["0", "-1", "abc", "", "1.5"]) {
      expect(conciliadosPage(292, pc).offset).toBe(0);
    }
  });

  it("lista vazia: página única, sem deslocamento", () => {
    expect(conciliadosPage(0, "3")).toEqual({ total: 0, offset: 0, limit: 30 });
  });

  it("o Pager do card navega por ?pc= e preserva os filtros conta/de/ate", () => {
    const html = renderToStaticMarkup(
      createElement(Pager, {
        page: conciliadosPage(292, "2"),
        basePath: "/conciliacao",
        param: "pc",
        extraQuery: { conta: "bnk_1", de: "2026-09-01", ate: undefined },
      })
    );
    expect(html).toContain("Página 2 de 10 · 292 registro(s)");
    // Página 1 não leva o parâmetro (mesma convenção da tabela de não conciliadas).
    expect(html).toContain('href="/conciliacao?conta=bnk_1&amp;de=2026-09-01"');
    expect(html).toContain('href="/conciliacao?conta=bnk_1&amp;de=2026-09-01&amp;pc=3"');
    expect(html).toContain("← Anterior");
    expect(html).toContain("Próxima →");
  });

  it("com até 30 conciliados o Pager não aparece", () => {
    const html = renderToStaticMarkup(
      createElement(Pager, { page: conciliadosPage(30, undefined), basePath: "/conciliacao", param: "pc" })
    );
    expect(html).toBe("");
  });
});
