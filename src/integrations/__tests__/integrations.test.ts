import { describe, expect, it } from "vitest";
import { ValidationError } from "@/core/errors";
import { buildIntegrations } from "../registry";
import {
  MockBankDataProvider,
  MockChargeProvider,
  MockFiscalProvider,
  MockMessagingProvider,
} from "../mock";

describe("integrations / MockBankDataProvider", () => {
  const params = {
    bankAccountId: "ba_1",
    bankCode: "341",
    accountNumberMasked: "***1234",
    since: "2026-07-19",
    until: "2026-08-18",
  };

  it("gera extrato sintético determinístico: mesmos parâmetros → mesmas transações", async () => {
    const provider = new MockBankDataProvider();
    const first = await provider.listTransactions(params);
    const second = await provider.listTransactions(params);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    for (const t of first) {
      expect(t.providerTxId).toMatch(/^mock-[0-9a-f]{16}$/);
      expect(t.date >= params.since && t.date <= params.until).toBe(true);
      expect(Number.isInteger(t.amountCents)).toBe(true);
      expect(t.amountCents).not.toBe(0);
      expect(t.description).toContain("SYNC MOCK");
    }
  });

  it("contas diferentes produzem extratos diferentes (seed por conta+dia)", async () => {
    const provider = new MockBankDataProvider();
    const a = await provider.listTransactions(params);
    const b = await provider.listTransactions({ ...params, bankAccountId: "ba_2" });
    expect(a.map((t) => t.providerTxId)).not.toEqual(b.map((t) => t.providerTxId));
  });
});

describe("integrations / MockChargeProvider", () => {
  const base = {
    amountCents: 123_456,
    dueDate: "2026-09-10",
    customerName: "Cliente Beta Ltda",
    receivableId: "rcv_1",
  } as const;

  it("pix: código BR-Code-like determinístico e claramente fake", async () => {
    const provider = new MockChargeProvider();
    const first = await provider.createCharge({ ...base, kind: "pix" });
    const second = await provider.createCharge({ ...base, kind: "pix" });

    expect(second).toEqual(first);
    expect(first.provider).toBe("mock");
    expect(first.chargeId).toMatch(/^chg_[0-9a-f]{12}$/);
    expect(first.code).toContain("MOCK");
    expect(first.expiresAt).toBe(base.dueDate);
  });

  it("boleto: linha digitável fake de 47 dígitos; tipo diferente → cobrança diferente", async () => {
    const provider = new MockChargeProvider();
    const boleto = await provider.createCharge({ ...base, kind: "boleto" });
    const pix = await provider.createCharge({ ...base, kind: "pix" });

    expect(boleto.code).toMatch(/^\d{47}$/);
    expect(boleto.chargeId).not.toBe(pix.chargeId);
  });
});

describe("integrations / MockFiscalProvider", () => {
  it("emite NF-e mock com número sequencial e chave de acesso determinística de 44 dígitos", async () => {
    const provider = new MockFiscalProvider();
    const params = {
      invoice: { id: "inv_1", description: "Venda", totalCents: 90_000 },
      company: { id: "co_1", cnpj: "12.345.678/0001-90", name: "Empresa Demo" },
      sequential: 7,
      issuedAtIso: "2026-08-18T15:00:00.000Z",
    };
    const first = await provider.issueInvoice(params);
    const second = await provider.issueInvoice(params);

    expect(second).toEqual(first);
    expect(first.provider).toBe("mock");
    expect(first.number).toBe("NFE-7");
    expect(first.accessKey).toMatch(/^\d{44}$/);
    expect(first.issuedAt).toBe(params.issuedAtIso);
  });
});

describe("integrations / MockMessagingProvider", () => {
  it("'envia' sem efeito externo com messageId determinístico", async () => {
    const provider = new MockMessagingProvider();
    const params = {
      channel: "email",
      to: "financeiro@beta.com.br",
      subject: "Lembrete de vencimento",
      body: "Olá!",
    } as const;
    const first = await provider.send(params);
    const second = await provider.send(params);

    expect(second).toEqual(first);
    expect(first.provider).toBe("mock");
    expect(first.messageId).toMatch(/^msg_[0-9a-f]{12}$/);
    expect(first.status).toBe("sent");
  });
});

describe("integrations / buildIntegrations (registro por env)", () => {
  it("default (env vazio) monta os quatro mocks", () => {
    const integrations = buildIntegrations({});
    expect(integrations.bankData.provider).toBe("mock");
    expect(integrations.charges.provider).toBe("mock");
    expect(integrations.fiscal.provider).toBe("mock");
    expect(integrations.messaging.provider).toBe("mock");
  });

  it("aceita 'mock' explícito (case-insensitive)", () => {
    expect(() =>
      buildIntegrations({
        INTEGRATION_BANK: "mock",
        INTEGRATION_CHARGES: "Mock",
        INTEGRATION_FISCAL: "MOCK",
        INTEGRATION_MESSAGING: "mock",
      })
    ).not.toThrow();
  });

  it("provedor real não implementado falha ALTO na inicialização (nunca cai no mock em silêncio)", () => {
    expect(() => buildIntegrations({ INTEGRATION_BANK: "pluggy" })).toThrow(ValidationError);
    expect(() => buildIntegrations({ INTEGRATION_CHARGES: "gerencianet" })).toThrow(ValidationError);
    expect(() => buildIntegrations({ INTEGRATION_FISCAL: "enotas" })).toThrow(ValidationError);
    expect(() => buildIntegrations({ INTEGRATION_MESSAGING: "sendgrid" })).toThrow(ValidationError);
    expect(() => buildIntegrations({ INTEGRATION_BANK: "pluggy" })).toThrow(/INTEGRATION_BANK/);
  });
});
