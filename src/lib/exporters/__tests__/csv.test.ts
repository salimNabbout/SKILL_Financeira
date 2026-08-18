import { describe, expect, it } from "vitest";
import { toCsv } from "../csv";

const BOM = "\uFEFF";

describe("toCsv", () => {
  it("gera CSV com BOM, separador ';' e CRLF, inferindo colunas da primeira linha", () => {
    const csv = toCsv([
      { nome: "Fornecedor A", valor: 100 },
      { nome: "Fornecedor B", valor: 250 },
    ]);
    expect(csv.startsWith(BOM)).toBe(true);
    const body = csv.slice(1);
    expect(body).toBe("nome;valor\r\nFornecedor A;100\r\nFornecedor B;250\r\n");
  });

  it("usa colunas explícitas com rótulos e ordem definidos", () => {
    const csv = toCsv(
      [{ due: "2026-01-10", amount: 1234, extra: "ignorado" }],
      [
        { key: "amount", label: "Valor (centavos)" },
        { key: "due", label: "Vencimento" },
      ]
    );
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Valor (centavos);Vencimento");
    expect(lines[1]).toBe("1234;2026-01-10");
    expect(csv).not.toContain("ignorado");
  });

  it("escapa aspas, separador e quebras de linha", () => {
    const csv = toCsv([
      { a: 'diz "oi"', b: "com;ponto e vírgula", c: "linha1\nlinha2" },
    ]);
    const body = csv.slice(1);
    expect(body).toBe('a;b;c\r\n"diz ""oi""";"com;ponto e vírgula";"linha1\nlinha2"\r\n');
  });

  it("formata float com vírgula decimal e mantém inteiros", () => {
    const csv = toCsv([{ inteiro: 42, flutuante: 3.14, negativo: -0.5 }]);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe("42;3,14;-0,5");
  });

  it("converte null/undefined em vazio", () => {
    const csv = toCsv([{ a: null, b: undefined, c: "x" }]);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe(";;x");
  });

  it("sem linhas e sem colunas devolve apenas o BOM", () => {
    expect(toCsv([])).toBe(BOM);
  });

  it("sem linhas mas com colunas devolve apenas o cabeçalho", () => {
    const csv = toCsv([], [{ key: "a", label: "Coluna A" }]);
    expect(csv).toBe(`${BOM}Coluna A\r\n`);
  });
});
