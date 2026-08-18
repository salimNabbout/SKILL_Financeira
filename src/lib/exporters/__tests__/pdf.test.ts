import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildPdfReport, sanitizeWinAnsi } from "../pdf";

describe("sanitizeWinAnsi", () => {
  it("preserva acentuação latina (ção, ã, é) e substitui glifos fora de WinAnsi", () => {
    expect(sanitizeWinAnsi("Conciliação bancária — ok")).toBe("Conciliação bancária — ok");
    expect(sanitizeWinAnsi("ã õ ç é ü")).toBe("ã õ ç é ü");
    expect(sanitizeWinAnsi("emoji 😀 e kanji 漢")).toBe("emoji ? e kanji ?");
  });
});

describe("buildPdfReport", () => {
  it("gera Uint8Array não vazio começando com %PDF", async () => {
    const bytes = await buildPdfReport({
      title: "Relatório de Posição Financeira",
      subtitle: "Café Aurora Ltda — visão gerencial",
      generatedAtLabel: "18/08/2026 12:00",
      sections: [
        {
          heading: "Resumo",
          lines: [
            "Situação de caixa dentro do esperado para o período.",
            "Projeção de 90 dias sem insuficiência prevista.",
          ],
        },
      ],
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    const head = String.fromCharCode(...bytes.slice(0, 5));
    expect(head).toBe("%PDF-");
  });

  it("renderiza texto com acentos pt-BR sem lançar erro de encoding", async () => {
    const bytes = await buildPdfReport({
      title: "Provisões e obrigações — atenção à conciliação",
      generatedAtLabel: "18/08/2026 12:00",
      sections: [
        {
          heading: "Observações",
          lines: ["Títulos com juros e correção monetária: ação imediata no próximo mês."],
          table: {
            headers: ["Descrição", "Situação"],
            rows: [["Energia elétrica — sede", "vencido há 7 dias"]],
          },
        },
      ],
    });
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("quebra em 2+ páginas com tabela grande e mantém documento carregável", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => [
      `pv_${i + 1}`,
      `Fornecedor com nome bem comprido para forçar truncamento número ${i + 1}`,
      "R$ 1.234,56",
      "2026-12-31",
    ]);
    const bytes = await buildPdfReport({
      title: "Contas a Pagar — Posição Completa",
      subtitle: "Listagem integral de títulos em aberto",
      generatedAtLabel: "18/08/2026 12:00",
      sections: [
        { heading: "Introdução", lines: ["Listagem completa de títulos do período."] },
        {
          heading: "Títulos",
          table: { headers: ["ID", "Fornecedor", "Valor", "Vencimento"], rows },
        },
      ],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("faz wrap de linhas longas gerando páginas extras quando necessário", async () => {
    const longLine =
      "Este é um parágrafo propositalmente extenso sobre governança financeira, alçadas de aprovação, segregação de funções e conciliação bancária, repetido para validar a quebra de linha manual por largura de fonte. ";
    const bytes = await buildPdfReport({
      title: "Notas Metodológicas",
      generatedAtLabel: "18/08/2026 12:00",
      sections: [{ heading: "Metodologia", lines: Array.from({ length: 40 }, () => longLine.repeat(3)) }],
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
