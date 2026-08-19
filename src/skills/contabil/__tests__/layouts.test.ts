import { describe, expect, it } from "vitest";
import type { AccountingEntry } from "@/core/entities";
import { EXPORT_LAYOUTS, layoutFilename, renderLayoutLines } from "../layouts";

const ENTRIES: AccountingEntry[] = [
  {
    id: "ae_1",
    companyId: "co_demo",
    entryDate: "2026-08-05",
    debitAccount: "4.2",
    creditAccount: "1.1",
    amountCents: 123_456,
    memo: "Pagamento fornecedor; energia\nagosto",
    sourceType: "payment",
    sourceId: "pay_1",
    exported: false,
    createdAt: "2026-08-18T15:00:00.000Z",
  },
  {
    id: "ae_2",
    companyId: "co_demo",
    entryDate: "2026-08-10",
    debitAccount: "1.1",
    creditAccount: "3.1",
    amountCents: 250_000,
    memo: "Recebimento, cliente Beta",
    sourceType: "receipt",
    sourceId: "rcp_1",
    exported: false,
    createdAt: "2026-08-18T15:00:00.000Z",
  },
];

describe("layouts de exportação contábil", () => {
  it("padrao: byte-compatível com o CSV histórico (';', ISO, cabeçalho)", () => {
    const lines = renderLayoutLines(EXPORT_LAYOUTS.padrao, ENTRIES);
    expect(lines).toEqual([
      "data;conta_debito;conta_credito;valor;historico;origem",
      "2026-08-05;4.2;1.1;1234,56;Pagamento fornecedor  energia agosto;payment:pay_1",
      "2026-08-10;1.1;3.1;2500,00;Recebimento, cliente Beta;receipt:rcp_1",
    ]);
    expect(layoutFilename(EXPORT_LAYOUTS.padrao, "2026-08")).toBe(
      "lancamentos-2026-08-padrao.csv"
    );
  });

  it("dominio (referência): sem cabeçalho, data DD/MM/AAAA, TXT, sem coluna de origem", () => {
    const lines = renderLayoutLines(EXPORT_LAYOUTS.dominio, ENTRIES);
    expect(lines).toEqual([
      "05/08/2026;4.2;1.1;1234,56;Pagamento fornecedor  energia agosto",
      "10/08/2026;1.1;3.1;2500,00;Recebimento, cliente Beta",
    ]);
    expect(layoutFilename(EXPORT_LAYOUTS.dominio, "2026-08")).toBe(
      "lancamentos-2026-08-dominio.txt"
    );
    expect(EXPORT_LAYOUTS.dominio.reference).toContain("REFERÊNCIA");
  });

  it("omie (referência): cabeçalho em português e data brasileira", () => {
    const lines = renderLayoutLines(EXPORT_LAYOUTS.omie, ENTRIES);
    expect(lines[0]).toBe("Data;Conta Débito;Conta Crédito;Valor;Histórico;Origem");
    expect(lines[1]).toBe(
      "05/08/2026;4.2;1.1;1234,56;Pagamento fornecedor  energia agosto;payment:pay_1"
    );
  });

  it("contmatic (referência): separador ',' força decimal em ponto e sanea o memo", () => {
    const lines = renderLayoutLines(EXPORT_LAYOUTS.contmatic, ENTRIES);
    expect(lines).toHaveLength(2); // sem cabeçalho
    // Nem a vírgula do memo nem a do decimal podem quebrar colunas:
    expect(lines[1]).toBe("10/08/2026,1.1,3.1,2500.00,Recebimento  cliente Beta");
    expect(lines[1].split(",")).toHaveLength(5);
  });

  it("invariante: separador ',' implica decimal em ponto (colisão impossível)", () => {
    for (const layout of Object.values(EXPORT_LAYOUTS)) {
      if (layout.separator === ",") expect(layout.amountFormat).toBe("dot");
    }
  });

  it("valores negativos preservam o sinal em todos os layouts", () => {
    const negative: AccountingEntry = { ...ENTRIES[0], amountCents: -50 };
    for (const layout of Object.values(EXPORT_LAYOUTS)) {
      const [line] = renderLayoutLines({ ...layout, includeHeader: false }, [negative]);
      expect(line).toMatch(/-0[.,]50/);
    }
  });
});
