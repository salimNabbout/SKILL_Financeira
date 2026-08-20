import { describe, expect, it } from "vitest";
import type { Supplier } from "@/core/entities";
import { parseSuppliersCsv, suppliersToCsvRows } from "../_lib/csv";

function sup(over: Partial<Supplier>): Supplier {
  return {
    id: "sup_1",
    companyId: "co_1",
    name: "FORNECEDOR ALFA",
    document: "11.222.333/0001-44",
    email: "a@alfa.com",
    phone: "21999990000",
    costClassification: "fixed",
    category: "Material De Escritório",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("suppliersToCsvRows", () => {
  it("gera uma linha por fornecedor com as colunas do cadastro", () => {
    const rows = suppliersToCsvRows([sup({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Fornecedor: "FORNECEDOR ALFA",
      "CNPJ/CPF": "11.222.333/0001-44",
      "E-mail": "a@alfa.com",
      Telefone: "21999990000",
      "Classificação do Custo": "Custo Fixo",
      Categoria: "Material De Escritório",
      Situação: "Ativo",
    });
  });

  it("traduz custo variável e campos vazios", () => {
    const rows = suppliersToCsvRows([
      sup({ costClassification: "variable", email: undefined, category: undefined, active: false }),
    ]);
    expect(rows[0]["Classificação do Custo"]).toBe("Custo Variável");
    expect(rows[0]["E-mail"]).toBe("");
    expect(rows[0].Categoria).toBe("");
    expect(rows[0].Situação).toBe("Inativo");
  });
});

describe("parseSuppliersCsv", () => {
  it("lê linhas do CSV para entradas de fornecedor (nome em maiúsculas, categoria Title Case)", () => {
    const csv =
      "Fornecedor;CNPJ/CPF;E-mail;Telefone;Classificação do Custo;Categoria\r\n" +
      "fornecedor beta;22.333.444/0001-55;b@beta.com;21988887777;Custo Variável;material de limpeza\r\n";
    const { entries, errors } = parseSuppliersCsv(csv);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: "FORNECEDOR BETA",
      document: "22.333.444/0001-55",
      email: "b@beta.com",
      phone: "21988887777",
      costClassification: "variable",
      category: "Material De Limpeza",
    });
  });

  it("reporta erro em linha sem CNPJ (obrigatório)", () => {
    const csv = "Fornecedor;CNPJ/CPF\r\nSem Documento;\r\n";
    const { entries, errors } = parseSuppliersCsv(csv);
    expect(entries).toHaveLength(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/CNPJ|documento/i);
  });
});
