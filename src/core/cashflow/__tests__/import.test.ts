/**
 * Importação da aba Lançamentos — parsers de célula e a validação
 * tudo-ou-nada com deduplicação (sem dupla contagem na reimportação).
 */
import { describe, expect, it } from "vitest";
import type { CashflowManualEntry } from "@/core/entities";
import {
  manualEntrySignature,
  parseImportAmount,
  parseImportDate,
  validateCashflowImport,
  type CashflowImportContext,
  type CashflowImportRawRow,
} from "../import";
import { seedCashflowCategories } from "../plan";

const NOW = "2026-09-18T12:00:00.000Z";
const categories = seedCashflowCategories();
const idOf = (name: string) => categories.find((c) => c.name === name)!.id;

const costCenters: CashflowImportContext["costCenters"] = [
  { id: "cc_adm", code: "CC-01", name: "Administrativo", active: true },
  { id: "cc_eng", code: "CC-02", name: "Engenharia", active: false },
];

function manual(over: Partial<CashflowManualEntry> = {}): CashflowManualEntry {
  return {
    id: "fca_1",
    companyId: "co_1",
    competenceDate: "2026-07-05",
    kind: "entrada",
    categoryId: idOf("Prestação de Serviços"),
    description: "Contrato SCADA cliente A",
    costCenterId: "cc_eng",
    status: "realizado",
    amountCents: 9_200_000,
    sourceNote: "importação planilha antiga.xlsx",
    createdBy: "u",
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...over,
  };
}

function row(linha: number, over: Partial<CashflowImportRawRow> = {}): CashflowImportRawRow {
  return {
    linha,
    data: 46208, // 2026-07-05
    tipo: "Entrada",
    categoria: "Prestação de Serviços",
    descricao: "Contrato SCADA cliente A",
    centro: "Engenharia",
    status: "Realizado",
    valor: 92000,
    ...over,
  };
}

const ctx = (manualEntries: CashflowManualEntry[] = []): CashflowImportContext => ({ categories, costCenters, manualEntries });

describe("parsers de célula", () => {
  it("data: número de série do Excel, ISO (com ou sem hora) e DD/MM/AAAA; inválidas → null", () => {
    expect(parseImportDate(46023)).toBe("2026-01-01");
    expect(parseImportDate(46208)).toBe("2026-07-05");
    expect(parseImportDate("2026-07-05")).toBe("2026-07-05");
    expect(parseImportDate("2026-07-05T00:00:00")).toBe("2026-07-05");
    expect(parseImportDate("5/7/2026")).toBe("2026-07-05");
    expect(parseImportDate("31/02/2026")).toBeNull();
    expect(parseImportDate("abc")).toBeNull();
    expect(parseImportDate(12)).toBeNull();
    expect(parseImportDate(undefined)).toBeNull();
  });

  it("valor: número da planilha (sem erro de float) e textos pt-BR/en → centavos", () => {
    expect(parseImportAmount(92000)).toBe(9_200_000);
    expect(parseImportAmount(1234.56)).toBe(123_456);
    expect(parseImportAmount(0.1 + 0.2)).toBe(30);
    expect(parseImportAmount("1.234,56")).toBe(123_456);
    expect(parseImportAmount("R$ 1.234,56")).toBe(123_456);
    expect(parseImportAmount("1234.5")).toBe(123_450);
    expect(parseImportAmount("1.234")).toBe(123_400);
    expect(parseImportAmount("(50,00)")).toBe(-5_000);
    expect(parseImportAmount("abc")).toBeNull();
    expect(parseImportAmount("")).toBeNull();
  });
});

describe("validateCashflowImport", () => {
  it("linha nova válida: resolve categoria por nome (sem acento/caixa), centro por nome ou código, status e tipo; totais por tipo", () => {
    const out = validateCashflowImport(
      [
        row(2, { categoria: "prestacao de servicos", centro: "cc-01", tipo: "entrada" }),
        row(3, { tipo: "Saída", categoria: "Aluguel", descricao: "Aluguel julho", centro: "", status: "Previsto", valor: "4.500,00" }),
      ],
      ctx()
    );
    expect(out.erros).toEqual([]);
    expect(out.ignoradas).toEqual([]);
    expect(out.linhasLidas).toBe(2);
    expect(out.validas).toHaveLength(2);
    expect(out.validas[0]).toMatchObject({ linha: 2, competenceDate: "2026-07-05", kind: "entrada", categoryId: idOf("Prestação de Serviços"), categoryName: "Prestação de Serviços", costCenterId: "cc_adm", costCenterName: "Administrativo", status: "realizado", amountCents: 9_200_000 });
    expect(out.validas[1]).toMatchObject({ linha: 3, kind: "saida", categoryId: idOf("Aluguel"), status: "previsto", amountCents: 450_000 });
    expect(out.validas[1].costCenterId).toBeUndefined();
    expect(out.totais).toEqual({ entradasCents: 9_200_000, saidasCents: 450_000 });
  });

  it("acumula TODOS os problemas da linha e não deixa nada válido passar despercebido (tudo-ou-nada é decisão de quem aplica)", () => {
    const out = validateCashflowImport(
      [
        row(2),
        row(3, { data: "31/02/2026", tipo: "Transferência", categoria: "Inexistente", descricao: "", centro: "Fiscal", status: "Pago", valor: "abc" }),
        row(4, { tipo: "Entrada", categoria: "Aluguel" }),
        row(5, { valor: -10 }),
        row(6, { origem: "Planeta Marte" }),
      ],
      ctx()
    );
    expect(out.validas.map((v) => v.linha)).toEqual([2]);
    expect(out.erros.map((e) => e.linha)).toEqual([3, 4, 5, 6]);
    const l3 = out.erros[0].motivo;
    for (const trecho of ["Data inválida", 'Tipo "Transferência"', 'Categoria "Inexistente"', "Descrição obrigatória", 'Centro de custo "Fiscal"', 'Status "Pago"', 'Valor "abc"']) {
      expect(l3).toContain(trecho);
    }
    expect(out.erros[1].motivo).toContain('Categoria "Aluguel" é de saída; a linha é de entrada');
    expect(out.erros[2].motivo).toContain("positivo");
    expect(out.erros[3].motivo).toContain("Origem");
    expect(out.erros[0].conteudo[0]).toBe("31/02/2026");
  });

  it("linhas em branco são puladas sem contar; origem do app é ignorada (o app já tem o lançamento)", () => {
    const out = validateCashflowImport(
      [
        { linha: 2 },
        { linha: 3, data: "", tipo: "", categoria: "", descricao: "", valor: "" },
        row(4, { origem: "Contas a pagar", referencia: "pv_1" }),
        row(5, { origem: "Conciliação bancária" }),
        row(6, { origem: "A Receber" }),
        row(7, { origem: "Ajuste manual" }),
      ],
      ctx()
    );
    expect(out.linhasLidas).toBe(4);
    expect(out.ignoradas.map((s) => [s.linha, s.motivo])).toEqual([
      [4, "origem_app"],
      [5, "origem_app"],
      [6, "origem_app"],
    ]);
    expect(out.ignoradas[0].detalhe).toContain("pv_1");
    expect(out.validas.map((v) => v.linha)).toEqual([7]);
    expect(out.erros).toEqual([]);
  });

  it("reimportação: referência de ajuste existente → ignorada (aviso se divergir); linha idêntica a ajuste existente → duplicada; referência desconhecida → nova com aviso", () => {
    const existing = manual();
    const out = validateCashflowImport(
      [
        row(2, { origem: "Ajuste manual", referencia: "fca_1" }),
        row(3, { origem: "Ajuste manual", referencia: "fca_1", valor: 1 }),
        row(4),
        row(5, { referencia: "fca_desconhecido", descricao: "Outra coisa" }),
        row(6, { descricao: "Nova linha" }),
        row(7, { descricao: "Nova linha" }),
      ],
      ctx([existing])
    );
    expect(out.erros).toEqual([]);
    expect(out.ignoradas.map((s) => [s.linha, s.motivo])).toEqual([
      [2, "ja_existente"],
      [3, "ja_existente"],
      [4, "duplicado"],
    ]);
    expect(out.ignoradas[1].detalhe).toContain("diverge");
    expect(out.ignoradas[2].detalhe).toContain("fca_1");
    expect(out.validas.map((v) => v.linha)).toEqual([5, 6, 7]);
    expect(out.avisos.some((a) => a.startsWith("Linha 3:") && /alterado/.test(a))).toBe(true);
    expect(out.avisos.some((a) => a.startsWith("Linha 5:") && /não encontrada/.test(a))).toBe(true);
    expect(out.avisos.some((a) => a.startsWith("Linha 7:") && /idêntica à linha 6/.test(a))).toBe(true);
  });

  it("assinatura ignora caixa/acento/espaços da descrição e distingue centro, status, valor e data", () => {
    const base = manual();
    expect(manualEntrySignature(base)).toBe(manualEntrySignature({ ...base, description: "  CONTRATO scada CLIENTE a " }));
    expect(manualEntrySignature(base)).not.toBe(manualEntrySignature({ ...base, status: "previsto" }));
    expect(manualEntrySignature(base)).not.toBe(manualEntrySignature({ ...base, costCenterId: undefined }));
    expect(manualEntrySignature(base)).not.toBe(manualEntrySignature({ ...base, amountCents: 1 }));
    expect(manualEntrySignature(base)).not.toBe(manualEntrySignature({ ...base, competenceDate: "2026-07-06" }));
  });
});
