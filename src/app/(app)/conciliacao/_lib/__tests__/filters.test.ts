import { describe, expect, it } from "vitest";
import { filtersToQuery, resolveFilters } from "../filters";
import type { BankAccount } from "@/core/entities";

const HOJE = "2026-09-04" as const;

function conta(over: Partial<BankAccount> & { id: string }): BankAccount {
  return {
    companyId: "co_1",
    name: "Conta",
    bankCode: "001",
    agency: "0001",
    accountNumberMasked: "****1234",
    type: "checking",
    currency: "BRL",
    openingBalanceCents: 0,
    openingBalanceDate: "2026-01-01",
    active: true,
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
    ...over,
  };
}

const CONTAS = [conta({ id: "bnk_1" }), conta({ id: "bnk_2" }), conta({ id: "bnk_3", active: false })];

describe("resolveFilters", () => {
  it("sem parâmetros: primeira conta ativa, do início do mês até hoje", () => {
    const f = resolveFilters({}, CONTAS, HOJE);

    expect(f.bankAccountId).toBe("bnk_1");
    expect(f.from).toBe("2026-09-01");
    expect(f.to).toBe(HOJE);
    expect(f.periodoInvalido).toBe(false);
  });

  it("respeita a conta escolhida quando ela está ativa", () => {
    expect(resolveFilters({ conta: "bnk_2" }, CONTAS, HOJE).bankAccountId).toBe("bnk_2");
  });

  it("conta inativa, inexistente ou de outra empresa cai no default", () => {
    expect(resolveFilters({ conta: "bnk_3" }, CONTAS, HOJE).bankAccountId).toBe("bnk_1");
    expect(resolveFilters({ conta: "bnk_999" }, CONTAS, HOJE).bankAccountId).toBe("bnk_1");
  });

  it("sem nenhuma conta ativa, não há conta selecionada", () => {
    const f = resolveFilters({}, [conta({ id: "bnk_3", active: false })], HOJE);
    expect(f.bankAccountId).toBeUndefined();
  });

  it("datas malformadas caem no default, sem quebrar a tela", () => {
    const f = resolveFilters({ de: "04/09/2026", ate: "ontem" }, CONTAS, HOJE);
    expect(f.from).toBe("2026-09-01");
    expect(f.to).toBe(HOJE);
  });

  it("período informado é respeitado nas duas pontas", () => {
    const f = resolveFilters({ de: "2026-07-01", ate: "2026-07-31" }, CONTAS, HOJE);
    expect(f.from).toBe("2026-07-01");
    expect(f.to).toBe("2026-07-31");
  });

  it("data inicial maior que a final é sinalizada, não corrigida", () => {
    const f = resolveFilters({ de: "2026-09-30", ate: "2026-09-01" }, CONTAS, HOJE);
    expect(f.periodoInvalido).toBe(true);
  });
});

describe("filtersToQuery", () => {
  it("monta a query só com o que está preenchido", () => {
    expect(filtersToQuery({ conta: "bnk_2", de: "2026-09-01", ate: "2026-09-30" })).toBe(
      "&conta=bnk_2&de=2026-09-01&ate=2026-09-30"
    );
  });

  it("sem filtro, devolve string vazia (não deixa um '&' solto na URL)", () => {
    expect(filtersToQuery({})).toBe("");
  });

  it("ignora campos vazios", () => {
    expect(filtersToQuery({ conta: "bnk_1", de: "", ate: undefined })).toBe("&conta=bnk_1");
  });
});
