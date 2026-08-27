import { describe, expect, it } from "vitest";
import type { CostCenter, Payable, Supplier, SupplierCategory } from "@/core/entities";
import { parsePayableFilters, describeFilters, filtersToQuery } from "../_lib/filters";
import { PAYABLE_EXPORT_COLUMNS, payablesToExportRows, totalsOf } from "../_lib/export-rows";
import {
  buildErrorLogCsv,
  buildImportTemplate,
  parseDataBR,
  validateImportCsv,
  type ImportContext,
} from "../_lib/import-csv";

const CO = "co_1";

function supplier(over: Partial<Supplier> & { id: string; name: string }): Supplier {
  return { companyId: CO, active: true, createdAt: "", updatedAt: "", ...over };
}
function categoria(name: string, active = true): SupplierCategory {
  return { id: `cat_${name}`, companyId: CO, name, active, createdAt: "", updatedAt: "" };
}
function centro(over: Partial<CostCenter> & { id: string; code: string }): CostCenter {
  return {
    companyId: CO,
    name: `Centro ${over.code}`,
    active: true,
    scope: "both",
    ...over,
  };
}
function payable(over: Partial<Payable> & { id: string }): Payable {
  return {
    companyId: CO,
    supplierId: "sup_1",
    description: "Título",
    issueDate: "2026-06-01",
    dueDate: "2026-07-01",
    amountCents: 10_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `k_${over.id}`,
    createdBy: "usr",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const ctxBase: ImportContext = {
  suppliers: [supplier({ id: "sup_1", name: "Fornecedora Alfa Ltda" })],
  categories: [categoria("Insumos Gerais")],
  costCenters: [
    centro({ id: "cc_1", code: "CC-01" }),
    centro({ id: "cc_r", code: "CC-R", scope: "receivable" }),
  ],
  payables: [],
  documentNumberByPayable: new Map(),
};

const CABECALHO =
  "Fornecedor;Descrição;Valor;Nº do Documento;Emissão;Vencimento;Categoria;Classificação do Custo;Centro de Custo;Tipo de Lançamento;Número de Parcelas";

describe("filtros da listagem", () => {
  it("período explícito vence Ano/Mês", () => {
    const f = parsePayableFilters({ ano: "2026", mes: "3", de: "2026-08-01", ate: "2026-08-31" });
    expect(f.dueFrom).toBe("2026-08-01");
    expect(f.dueTo).toBe("2026-08-31");
  });

  it("ano sem mês cobre o ano inteiro; com mês, o mês fechado", () => {
    expect(parsePayableFilters({ ano: "2026" }).dueFrom).toBe("2026-01-01");
    expect(parsePayableFilters({ ano: "2026" }).dueTo).toBe("2026-12-31");
    expect(parsePayableFilters({ ano: "2026", mes: "2" }).dueTo).toBe("2026-02-28");
  });

  it("acusa período invertido em vez de devolver lista vazia", () => {
    expect(parsePayableFilters({ de: "2026-08-31", ate: "2026-08-01" }).periodoInvalido).toBe(true);
  });

  it("status inválido cai para todos, sem filtrar nada fora", () => {
    const f = parsePayableFilters({ status: "inventado" });
    expect(f.status).toBe("todos");
    expect(f.statuses).toBeUndefined();
  });

  it("a query preserva os filtros para export e impressão", () => {
    const q = filtersToQuery({ status: "open", ano: "2026", fornecedor: "sup_1" });
    expect(q).toContain("status=open");
    expect(q).toContain("ano=2026");
    expect(q).toContain("fornecedor=sup_1");
  });

  it("descreve os filtros para o cabeçalho do relatório", () => {
    const f = parsePayableFilters({ status: "paid", ano: "2026", mes: "5" });
    expect(describeFilters(f, "Alfa")).toContain("Status: Pagos");
    expect(describeFilters(f, "Alfa")).toContain("Fornecedor: Alfa");
    expect(describeFilters(f, "Alfa")).toContain("Maio/2026");
  });
});

describe("linhas de exportação", () => {
  it("formata centavos em pt-BR e datas em DD/MM/AAAA", () => {
    const rows = payablesToExportRows(
      [payable({ id: "p1", amountCents: 150_000_000, paidCents: 1234 })],
      { suppliers: ctxBase.suppliers, costCenters: [], bankAccounts: [] }
    );
    expect(rows[0]["Valor (R$)"]).toBe("1.500.000,00");
    expect(rows[0]["Valor Pago (R$)"]).toBe("12,34");
    expect(rows[0]["Vencimento"]).toBe("01/07/2026");
    expect(rows[0]["Fornecedor"]).toBe("Fornecedora Alfa Ltda");
  });

  it("todas as colunas pedidas estão presentes", () => {
    const rows = payablesToExportRows([payable({ id: "p1" })], {
      suppliers: ctxBase.suppliers,
      costCenters: [],
      bankAccounts: [],
    });
    for (const coluna of PAYABLE_EXPORT_COLUMNS) {
      expect(rows[0]).toHaveProperty(coluna);
    }
  });

  it("soma os totais sobre o conjunto filtrado", () => {
    const t = totalsOf([
      payable({ id: "a", amountCents: 1000, paidCents: 500 }),
      payable({ id: "b", amountCents: 2500, paidCents: 0 }),
    ]);
    expect(t).toEqual({ quantidade: 2, valorCents: 3500, pagoCents: 500 });
  });
});

describe("importação por CSV", () => {
  it("aceita uma linha completa e converte reais para centavos", () => {
    const csv = `${CABECALHO}\r\nFornecedora Alfa Ltda;NF 10;1.234,56;10;10/06/2026;10/07/2026;Insumos Gerais;Custo Fixo;CC-01;Único;2`;
    const r = validateImportCsv(csv, ctxBase);
    expect(r.erros).toHaveLength(0);
    expect(r.validas[0].amountCents).toBe(123_456);
    expect(r.validas[0].installmentCount).toBe(2);
    expect(r.validas[0].costCenterId).toBe("cc_1");
    expect(r.validas[0].duplicado).toBe(false);
  });

  it("recusa fornecedor, categoria e centro de custo inexistentes", () => {
    const linhas = [
      "Fantasma Ltda;X;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1",
      "Fornecedora Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Inventada;Fixo;;Único;1",
      "Fornecedora Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;CC-99;Único;1",
    ];
    const r = validateImportCsv(`${CABECALHO}\r\n${linhas.join("\r\n")}`, ctxBase);
    expect(r.validas).toHaveLength(0);
    expect(r.erros).toHaveLength(3);
    expect(r.erros[0].motivo).toContain("não está cadastrado");
    expect(r.erros[1].motivo).toContain("Categoria");
    expect(r.erros[2].motivo).toContain("Centro de custo");
  });

  it("recusa centro de custo destinado a Contas a Receber", () => {
    const csv = `${CABECALHO}\r\nFornecedora Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;CC-R;Único;1`;
    const r = validateImportCsv(csv, ctxBase);
    expect(r.erros[0].motivo).toContain("Contas a Receber");
  });

  it("recusa valor não positivo e data inválida", () => {
    const linhas = [
      "Fornecedora Alfa Ltda;X;0,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1",
      "Fornecedora Alfa Ltda;X;10,00;;31/02/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1",
      "Fornecedora Alfa Ltda;X;10,00;;10/06/2026;01/06/2026;Insumos Gerais;Fixo;;Único;1",
    ];
    const r = validateImportCsv(`${CABECALHO}\r\n${linhas.join("\r\n")}`, ctxBase);
    expect(r.erros).toHaveLength(3);
    expect(r.erros[0].motivo).toContain("maior que zero");
    expect(r.erros[1].motivo).toContain("Emissão inválida");
    // Mesma mensagem da criação manual: a regra é uma só.
    expect(r.erros[2].motivo).toBe("Verificar a Data da Emissão");
  });

  it("marca duplicata por fornecedor + nº do documento, sem recusar a linha", () => {
    const ctx: ImportContext = {
      ...ctxBase,
      payables: [payable({ id: "p1", supplierId: "sup_1", documentId: "doc_1" })],
      documentNumberByPayable: new Map([["p1", "10"]]),
    };
    const csv = `${CABECALHO}\r\nFornecedora Alfa Ltda;NF 10;10,00;10;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1`;
    const r = validateImportCsv(csv, ctx);
    expect(r.erros).toHaveLength(0);
    expect(r.validas[0].duplicado).toBe(true);
  });

  it("uma linha inválida não impede as demais, e o número da linha bate com a planilha", () => {
    const linhas = [
      "Fornecedora Alfa Ltda;Boa;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1",
      "Fantasma;Ruim;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1",
      "Fornecedora Alfa Ltda;Boa 2;20,00;;01/06/2026;10/06/2026;Insumos Gerais;Variável;;Único;1",
    ];
    const r = validateImportCsv(`${CABECALHO}\r\n${linhas.join("\r\n")}`, ctxBase);
    expect(r.validas).toHaveLength(2);
    expect(r.erros).toHaveLength(1);
    // Cabeçalho é a linha 1; a linha ruim é a 3 do arquivo.
    expect(r.erros[0].linha).toBe(3);
    expect(r.validas[1].costClassification).toBe("variable");
  });

  it("ignora linhas em branco e aceita arquivo sem cabeçalho", () => {
    const csv = "Fornecedora Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1\r\n\r\n";
    const r = validateImportCsv(csv, ctxBase);
    expect(r.validas).toHaveLength(1);
    expect(r.erros).toHaveLength(0);
  });

  it("o modelo tem BOM e as colunas na ordem documentada", () => {
    const modelo = buildImportTemplate();
    expect(modelo.startsWith("﻿")).toBe(true);
    expect(modelo.split("\r\n")[0]).toContain("Fornecedor;Descrição;Valor");
  });

  it("o log de erros traz linha, motivo e o conteúdo original", () => {
    const r = validateImportCsv(
      `${CABECALHO}\r\nFantasma;X;10,00;;01/06/2026;10/06/2026;Insumos Gerais;Fixo;;Único;1`,
      ctxBase
    );
    const log = buildErrorLogCsv(r.erros);
    expect(log).toContain("Linha;Motivo");
    expect(log).toContain("Fantasma");
  });
});

describe("parseDataBR", () => {
  it("aceita DD/MM/AAAA e ISO, recusa data impossível", () => {
    expect(parseDataBR("10/06/2026")).toBe("2026-06-10");
    expect(parseDataBR("2026-06-10")).toBe("2026-06-10");
    expect(parseDataBR("31/02/2026")).toBeNull();
    expect(parseDataBR("")).toBeNull();
  });
});
