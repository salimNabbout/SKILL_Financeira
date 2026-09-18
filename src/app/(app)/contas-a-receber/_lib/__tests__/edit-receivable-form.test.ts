/**
 * Render test (renderToStaticMarkup) do formulário de edição de título a
 * receber: cada `mode` submete SÓ os campos que a sua server action/skill
 * aceita — o resto fica desabilitado e sem `name`. É o contrato entre o
 * formulário e `update_receivable` / `reclassify_receivable`.
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

import { EditReceivableForm, type EditReceivableValues } from "../edit-receivable-form";

const RECEIVABLE: EditReceivableValues = {
  id: "rc_1",
  customerName: "Cafeteria Grão do Centro",
  description: "Pedido 1002 — fornecimento mensal",
  amount: "4870,00",
  issueDate: "2026-07-01",
  dueDate: "2026-07-20",
  categoryId: "cat_vendas",
  costCenterId: "cc_loja",
  notes: "",
  installmentNumber: 1,
  installmentCount: 1,
  fromInvoice: false,
  receivedDate: "2026-07-21",
};

const noop = async () => {};

function render(
  mode: "full" | "classificationOnly",
  over: Partial<EditReceivableValues> = {}
): string {
  return renderToStaticMarkup(
    createElement(EditReceivableForm, {
      receivable: { ...RECEIVABLE, ...over },
      action: noop,
      mode,
      categorias: [
        { id: "cat_vendas", name: "Vendas" },
        { id: "cat_servicos", name: "Serviços" },
      ],
      centros: [
        { id: "cc_loja", label: "CC-01 — Loja" },
        { id: "cc_adm", label: "CC-03 — Administrativo" },
      ],
      cancelHref: "/contas-a-receber",
    })
  );
}

/** Nomes de campos que o formulário SUBMETE (têm atributo name). */
function submittedNames(html: string): string[] {
  return [...html.matchAll(/name="([a-zA-Z]+)"/g)].map((m) => m[1]).sort();
}

describe("EditReceivableForm — campos submetidos por modo", () => {
  it("classificationOnly: só receivableId, categoryId e costCenterId", () => {
    const html = render("classificationOnly");
    expect(submittedNames(html)).toEqual(["categoryId", "costCenterId", "receivableId"]);
    // Os dois selects continuam ativos, com as opções e o valor atual.
    expect(html).toContain('<select name="categoryId"');
    expect(html).toContain('<select name="costCenterId"');
    expect(html).toContain('<option value="cc_adm">CC-03 — Administrativo</option>');
    // O resto está visível, mas desabilitado (não é submetido).
    expect(html).toMatch(/<input disabled="" [^>]*value="Pedido 1002 — fornecimento mensal"/);
    expect(html).toMatch(/<input disabled="" [^>]*value="4870,00"/);
    expect(html).toMatch(/<input type="date" disabled="" [^>]*value="2026-07-20"/);
    expect(html).toMatch(/<textarea rows="3" disabled=""/);
    // Data do Recebimento: só leitura (disabled, sem name), com a data da baixa.
    expect(html).toContain("Data do Recebimento");
    expect(html).toMatch(/<input type="date" disabled="" [^>]*value="2026-07-21"/);
    expect(html).toContain("Somente leitura: data registrada no recebimento.");
    expect(html).toContain("Salvar classificação");
    expect(html).toContain("Título já recebido");
  });

  it("full: descrição, valor, datas, classificação e observação são submetidos; Data do Recebimento fica só leitura", () => {
    const html = render("full", { receivedDate: undefined });
    expect(submittedNames(html)).toEqual(
      ["amount", "categoryId", "costCenterId", "description", "dueDate", "issueDate", "notes", "receivableId"].sort()
    );
    expect(html).toContain("Data do Recebimento");
    expect(html).toMatch(/<input disabled="" [^>]*value="—"/);
    expect(html).toContain("Preenchida quando o recebimento é registrado.");
    expect(html).toContain("Salvar alterações");
    expect(html).not.toContain("Título já recebido");
  });

  it("classificationOnly sem data (título recebido sem recibo ativo): Data do Recebimento mostra —", () => {
    const html = render("classificationOnly", { receivedDate: undefined });
    expect(html).toMatch(/<input disabled="" [^>]*value="—"/);
    expect(html).not.toContain('value="2026-07-21"');
    expect(submittedNames(html)).toEqual(["categoryId", "costCenterId", "receivableId"]);
  });
});
