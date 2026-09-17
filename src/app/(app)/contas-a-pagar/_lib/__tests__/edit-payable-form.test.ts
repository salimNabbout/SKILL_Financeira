/**
 * Render test (renderToStaticMarkup) do formulário de edição de título a pagar:
 * garante que cada `mode` submete SÓ os campos que a sua server action/skill
 * aceita — o resto fica desabilitado e sem `name`. É o contrato entre o
 * formulário e `update_payable` / `adjust_payment_date` / `reclassify_payable`.
 */

import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// O transform do vitest (esbuild) usa o runtime JSX clássico, que referencia o
// identificador global `React` — o Next usa o runtime automático, então os
// componentes não importam React. Suprimos o global apenas no teste.
(globalThis as { React?: typeof React }).React = React;

// next/link precisa do roteador do App Router; fora dele vira um <a> simples.
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
      h("a", { href: props.href, className: props.className }, props.children),
  };
});

import { EditPayableForm, type EditPayableValues } from "../edit-payable-form";

const PAYABLE: EditPayableValues = {
  id: "pv_1",
  supplierName: "Torrefação Serra Alta Ltda",
  description: "NF 1234 — grãos",
  amount: "7800,00",
  documentNumber: "NF-1234",
  issueDate: "2026-07-01",
  dueDate: "2026-07-20",
  supplierCategory: "Insumos",
  costClassification: "variable",
  costCenterId: "cc_loja",
  costCenterLabel: "CC-01 — Loja",
  notes: "",
  paymentDate: "2026-07-20",
  paymentDateMax: "2026-08-18",
  installmentNumber: 1,
  installmentCount: 1,
  scheduled: false,
};

const noop = async () => {};

function render(mode: "full" | "paymentDateOnly" | "classificationOnly"): string {
  return renderToStaticMarkup(
    createElement(EditPayableForm, {
      payable: PAYABLE,
      action: noop,
      mode,
      categories: ["Insumos", "Serviços"],
      costCenters: [
        { id: "cc_loja", label: "CC-01 — Loja" },
        { id: "cc_adm", label: "CC-03 — Administrativo" },
      ],
      cancelHref: "/contas-a-pagar",
    })
  );
}

/** Nomes de campos que o formulário SUBMETE (têm atributo name). */
function submittedNames(html: string): string[] {
  return [...html.matchAll(/name="([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
}

describe("EditPayableForm — campos submetidos por modo", () => {
  it("classificationOnly: só payableId, supplierCategory, costClassification e costCenterId", () => {
    const html = render("classificationOnly");
    expect(submittedNames(html)).toEqual(
      ["costCenterId", "costClassification", "payableId", "supplierCategory"].sort()
    );
    // Os três selects continuam ativos, com as opções e o valor atual.
    expect(html).toContain('<select name="supplierCategory"');
    expect(html).toContain('<select name="costClassification"');
    expect(html).toContain('<select name="costCenterId"');
    expect(html).toContain('<option value="cc_adm">CC-03 — Administrativo</option>');
    // O resto está visível, mas desabilitado (não é submetido).
    expect(html).toMatch(/<input disabled="" [^>]*value="NF 1234 — grãos"/);
    expect(html).toMatch(/<input disabled="" [^>]*value="7800,00"/);
    expect(html).toMatch(/<input type="date" disabled="" [^>]*value="2026-07-20"/);
    expect(html).toMatch(/<textarea rows="3" disabled=""/);
    expect(html).toContain("Salvar classificação");
    expect(html).toContain("Título já pago");
    expect(html).not.toContain('name="paymentDate"');
  });

  it("full: descrição, valor, datas, classificação e observação são submetidos", () => {
    const html = render("full");
    expect(submittedNames(html)).toEqual(
      [
        "amount",
        "costCenterId",
        "costClassification",
        "description",
        "dueDate",
        "issueDate",
        "notes",
        "payableId",
        "supplierCategory",
      ].sort()
    );
    expect(html).toContain("Salvar alterações");
    expect(html).not.toContain("Título já pago");
  });

  it("paymentDateOnly: só payableId e paymentDate", () => {
    const html = render("paymentDateOnly");
    expect(submittedNames(html)).toEqual(["payableId", "paymentDate"]);
    expect(html).toContain("Salvar data de pagamento");
  });
});
