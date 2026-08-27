import { describe, expect, it } from "vitest";
import type { Category, CostCenter, Customer, Receivable } from "@/core/entities";
import { parseReceivableFilters, describeFilters, filtersToQuery } from "../_lib/filters";

const HOJE = "2026-08-20";
import {
  RECEIVABLE_EXPORT_COLUMNS,
  receivablesToExportRows,
  totalsOf,
} from "../_lib/export-rows";
import {
  buildErrorLogCsv,
  buildImportTemplate,
  parseDataBR,
  validateImportCsv,
  type ImportContext,
} from "../_lib/import-csv";

const CO = "co_1";

function customer(over: Partial<Customer> & { id: string; name: string }): Customer {
  return { companyId: CO, active: true, createdAt: "", updatedAt: "", ...over };
}
function categoria(name: string, active = true): Category {
  return {
    id: `cat_${name}`,
    companyId: CO,
    name,
    kind: "income",
    dreGroup: "receita_bruta",
    active,
  };
}
function centro(over: Partial<CostCenter> & { id: string; code: string }): CostCenter {
  return { companyId: CO, name: `Centro ${over.code}`, active: true, ...over };
}
function receivable(over: Partial<Receivable> & { id: string }): Receivable {
  return {
    companyId: CO,
    customerId: "cus_1",
    description: "Título",
    issueDate: "2026-06-01",
    dueDate: "2026-07-01",
    amountCents: 10_000,
    receivedCents: 0,
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
  customers: [customer({ id: "cus_1", name: "Cliente Alfa Ltda" })],
  categories: [categoria("Receita de Serviços")],
  costCenters: [
    centro({ id: "cc_1", code: "CC-01" }),
  ],
  receivables: [],
  documentNumberByReceivable: new Map(),
};

const CABECALHO =
  "Cliente;Descrição;Valor;Nº do Documento;Emissão;Vencimento;Categoria;Centro de Custo;Número de Parcelas";

describe("filtros da listagem", () => {
  it("período explícito vence Ano/Mês", () => {
    const f = parseReceivableFilters({ ano: "2026", mes: "3", de: "2026-08-01", ate: "2026-08-31" }, HOJE);
    expect(f.dueFrom).toBe("2026-08-01");
    expect(f.dueTo).toBe("2026-08-31");
  });

  it("ano sem mês cobre o ano inteiro; com mês, o mês fechado", () => {
    expect(parseReceivableFilters({ ano: "2026" }, HOJE).dueFrom).toBe("2026-01-01");
    expect(parseReceivableFilters({ ano: "2026" }, HOJE).dueTo).toBe("2026-12-31");
    expect(parseReceivableFilters({ ano: "2026", mes: "2" }, HOJE).dueTo).toBe("2026-02-28");
  });

  it("acusa período invertido em vez de devolver lista vazia", () => {
    expect(parseReceivableFilters({ de: "2026-08-31", ate: "2026-08-01" }, HOJE).periodoInvalido).toBe(true);
  });

  it("situação inválida cai para todos, sem filtrar nada fora", () => {
    const f = parseReceivableFilters({ status: "inventado" }, HOJE);
    expect(f.situacao).toBe("todos");
    expect(f.statuses).toBeUndefined();
  });

  it("Atrasado recorta os títulos em aberto vencidos até ontem", () => {
    const f = parseReceivableFilters({ status: "atrasado" }, HOJE);
    expect(f.statuses).toEqual(["open", "partially_received"]);
    expect(f.dueTo).toBe("2026-08-19");
    expect(f.dueFrom).toBeUndefined();
  });

  it("Hoje recorta exatamente o dia", () => {
    const f = parseReceivableFilters({ status: "hoje" }, HOJE);
    expect(f.dueFrom).toBe(HOJE);
    expect(f.dueTo).toBe(HOJE);
  });

  it("situação e período se combinam por interseção, sem um anular o outro", () => {
    const f = parseReceivableFilters({ status: "a_vencer", de: "2026-08-01", ate: "2026-12-31" }, HOJE);
    expect(f.dueFrom).toBe("2026-08-21");
    expect(f.dueTo).toBe("2026-12-31");
  });

  it("a query preserva os filtros para export e impressão", () => {
    const q = filtersToQuery({ status: "atrasado", ano: "2026", cliente: "cus_1" });
    expect(q).toContain("status=atrasado");
    expect(q).toContain("ano=2026");
    expect(q).toContain("cliente=cus_1");
  });

  it("descreve os filtros para o cabeçalho do relatório", () => {
    const f = parseReceivableFilters({ status: "recebido", ano: "2026", mes: "5" }, HOJE);
    expect(describeFilters(f, "Alfa")).toContain("Situação: Recebido");
    expect(describeFilters(f, "Alfa")).toContain("Cliente: Alfa");
    expect(describeFilters(f, "Alfa")).toContain("Maio/2026");
  });
});

describe("linhas de exportação", () => {
  it("formata centavos em pt-BR e datas em DD/MM/AAAA", () => {
    const rows = receivablesToExportRows(
      [receivable({ id: "p1", amountCents: 150_000_000, receivedCents: 1234 })],
      { customers: ctxBase.customers, costCenters: [], bankAccounts: [] }
    );
    expect(rows[0]["Valor (R$)"]).toBe("1.500.000,00");
    expect(rows[0]["Valor Recebido (R$)"]).toBe("12,34");
    expect(rows[0]["Vencimento"]).toBe("01/07/2026");
    expect(rows[0]["Cliente"]).toBe("Cliente Alfa Ltda");
  });

  it("todas as colunas pedidas estão presentes", () => {
    const rows = receivablesToExportRows([receivable({ id: "p1" })], {
      customers: ctxBase.customers,
      costCenters: [],
      bankAccounts: [],
    });
    for (const coluna of RECEIVABLE_EXPORT_COLUMNS) {
      expect(rows[0]).toHaveProperty(coluna);
    }
  });

  it("soma os totais sobre o conjunto filtrado", () => {
    const t = totalsOf([
      receivable({ id: "a", amountCents: 1000, receivedCents: 500 }),
      receivable({ id: "b", amountCents: 2500, receivedCents: 0 }),
    ]);
    expect(t).toEqual({ quantidade: 2, valorCents: 3500, recebidoCents: 500 });
  });
});

describe("importação por CSV", () => {
  it("aceita uma linha completa e converte reais para centavos", () => {
    const csv = `${CABECALHO}\r\nCliente Alfa Ltda;NF 10;1.234,56;10;10/06/2026;10/07/2026;Receita de Serviços;CC-01;2`;
    const r = validateImportCsv(csv, ctxBase);
    expect(r.erros).toHaveLength(0);
    expect(r.validas[0].amountCents).toBe(123_456);
    expect(r.validas[0].installmentCount).toBe(2);
    expect(r.validas[0].costCenterId).toBe("cc_1");
    expect(r.validas[0].duplicado).toBe(false);
  });

  it("recusa fornecedor, categoria e centro de custo inexistentes", () => {
    const linhas = [
      "Fantasma Ltda;X;10,00;;01/06/2026;10/06/2026;Receita de Serviços;;1",
      "Cliente Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Inventada;;1",
      "Cliente Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Receita de Serviços;CC-99;1",
    ];
    const r = validateImportCsv(`${CABECALHO}\r\n${linhas.join("\r\n")}`, ctxBase);
    expect(r.validas).toHaveLength(0);
    expect(r.erros).toHaveLength(3);
    expect(r.erros[0].motivo).toContain("não está cadastrado");
    expect(r.erros[1].motivo).toContain("Categoria");
    expect(r.erros[2].motivo).toContain("Centro de custo");
  });

  it("recusa valor não positivo e data inválida", () => {
    const linhas = [
      "Cliente Alfa Ltda;X;0,00;;01/06/2026;10/06/2026;Receita de Serviços;;1",
      "Cliente Alfa Ltda;X;10,00;;31/02/2026;10/06/2026;Receita de Serviços;;1",
      "Cliente Alfa Ltda;X;10,00;;10/06/2026;01/06/2026;Receita de Serviços;;1",
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
      receivables: [receivable({ id: "p1", customerId: "cus_1", documentId: "doc_1" })],
      documentNumberByReceivable: new Map([["p1", "10"]]),
    };
    const csv = `${CABECALHO}\r\nCliente Alfa Ltda;NF 10;10,00;10;01/06/2026;10/06/2026;Receita de Serviços;;1`;
    const r = validateImportCsv(csv, ctx);
    expect(r.erros).toHaveLength(0);
    expect(r.validas[0].duplicado).toBe(true);
  });

  it("uma linha inválida não impede as demais, e o número da linha bate com a planilha", () => {
    const linhas = [
      "Cliente Alfa Ltda;Boa;10,00;;01/06/2026;10/06/2026;Receita de Serviços;;1",
      "Fantasma;Ruim;10,00;;01/06/2026;10/06/2026;Receita de Serviços;;1",
      "Cliente Alfa Ltda;Boa 2;20,00;;01/06/2026;10/06/2026;Receita de Serviços;;1",
    ];
    const r = validateImportCsv(`${CABECALHO}\r\n${linhas.join("\r\n")}`, ctxBase);
    expect(r.validas).toHaveLength(2);
    expect(r.erros).toHaveLength(1);
    // Cabeçalho é a linha 1; a linha ruim é a 3 do arquivo.
    expect(r.erros[0].linha).toBe(3);
  });

  it("ignora linhas em branco e aceita arquivo sem cabeçalho", () => {
    const csv = "Cliente Alfa Ltda;X;10,00;;01/06/2026;10/06/2026;Receita de Serviços;;1\r\n\r\n";
    const r = validateImportCsv(csv, ctxBase);
    expect(r.validas).toHaveLength(1);
    expect(r.erros).toHaveLength(0);
  });

  it("o modelo tem BOM e as colunas na ordem documentada", () => {
    const modelo = buildImportTemplate();
    expect(modelo.startsWith("﻿")).toBe(true);
    expect(modelo.split("\r\n")[0]).toContain("Cliente;Descrição;Valor");
  });

  it("o log de erros traz linha, motivo e o conteúdo original", () => {
    const r = validateImportCsv(
      `${CABECALHO}\r\nFantasma;X;10,00;;01/06/2026;10/06/2026;Receita de Serviços;;1`,
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
