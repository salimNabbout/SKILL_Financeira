import { describe, expect, it } from "vitest";
import { buildIntegrations } from "@/integrations/registry";
import {
  PluggyBankDataProvider,
  readPluggyConfig,
  type PluggyConfig,
} from "@/integrations/providers/pluggy-bank-data-provider";
import { ValidationError } from "@/core/errors";

const ENV_OK = {
  PLUGGY_CLIENT_ID: "cid",
  PLUGGY_CLIENT_SECRET: "csec",
  PLUGGY_ACCOUNT_MAP: "ba_itau=acc-uuid-1",
};

/** fetch falso roteado por URL; registra as chamadas para inspeção. */
function fakeFetch(
  routes: Array<{ match: (url: string) => boolean; reply: (url: string, init?: RequestInit) => Response }>
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`rota não esperada no teste: ${url}`);
    return route.reply(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const AUTH_ROUTE = {
  match: (u: string) => u.endsWith("/auth"),
  reply: () => json({ apiKey: "jwt-teste" }),
};

function makeProvider(
  routes: Parameters<typeof fakeFetch>[0],
  overrides: Partial<PluggyConfig> = {}
) {
  const { fn, calls } = fakeFetch(routes);
  const provider = new PluggyBankDataProvider({
    clientId: "cid",
    clientSecret: "csec",
    accountMap: { ba_itau: "acc-uuid-1" },
    fetchFn: fn,
    ...overrides,
  });
  return { provider, calls };
}

const LIST_PARAMS = {
  bankAccountId: "ba_itau",
  bankCode: "341",
  accountNumberMasked: "****-0135",
  since: "2026-08-01",
  until: "2026-08-31",
};

describe("readPluggyConfig", () => {
  it("falha ALTO sem PLUGGY_CLIENT_ID/SECRET/ACCOUNT_MAP (nunca cai no mock)", () => {
    expect(() => readPluggyConfig({})).toThrow(ValidationError);
    expect(() => readPluggyConfig({ ...ENV_OK, PLUGGY_CLIENT_SECRET: undefined })).toThrow(
      ValidationError
    );
    expect(() => readPluggyConfig({ ...ENV_OK, PLUGGY_ACCOUNT_MAP: "sem-igual" })).toThrow(
      ValidationError
    );
  });

  it("aceita múltiplos pares no mapa, separados por vírgula", () => {
    const config = readPluggyConfig({
      ...ENV_OK,
      PLUGGY_ACCOUNT_MAP: "ba_a=uuid-a, ba_b=uuid-b",
    });
    expect(config.accountMap).toEqual({ ba_a: "uuid-a", ba_b: "uuid-b" });
  });
});

describe("registry (INTEGRATION_BANK)", () => {
  it("buildIntegrations({}) continua devolvendo mock em tudo", () => {
    const integrations = buildIntegrations({});
    expect(integrations.bankData.provider).toBe("mock");
    expect(integrations.charges.provider).toBe("mock");
  });

  it("INTEGRATION_BANK=pluggy sem credenciais falha alto; com credenciais instancia o Pluggy", () => {
    expect(() => buildIntegrations({ INTEGRATION_BANK: "pluggy" })).toThrow(ValidationError);
    const integrations = buildIntegrations({ INTEGRATION_BANK: "pluggy", ...ENV_OK });
    expect(integrations.bankData.provider).toBe("pluggy");
    expect(() => buildIntegrations({ INTEGRATION_BANK: "outro" })).toThrow(ValidationError);
  });
});

describe("PluggyBankDataProvider.listTransactions", () => {
  it("autentica em /auth e consulta /transactions com X-API-KEY (nunca as credenciais)", async () => {
    const { provider, calls } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/transactions"),
        reply: () => json({ results: [], page: 1, totalPages: 1 }),
      },
    ]);
    await provider.listTransactions(LIST_PARAMS);
    expect(calls[0].url).toContain("/auth");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ clientId: "cid", clientSecret: "csec" });
    const txCall = calls.find((c) => c.url.includes("/transactions"));
    expect((txCall?.init?.headers as Record<string, string>)["X-API-KEY"]).toBe("jwt-teste");
    expect(txCall?.url).toContain("accountId=acc-uuid-1");
    expect(txCall?.url).toContain("from=2026-08-01");
    expect(txCall?.url).toContain("to=2026-08-31");
  });

  it("pagina até totalPages e agrega os resultados em ordem de data", async () => {
    const tx = (id: string, date: string, amount: number, type: "DEBIT" | "CREDIT") => ({
      id,
      date,
      description: `tx ${id}`,
      amount,
      currencyCode: "BRL",
      type,
      status: "POSTED",
    });
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("page=1") && u.includes("/transactions"),
        reply: () =>
          json({ results: [tx("b", "2026-08-20T12:00:00Z", 10, "CREDIT")], page: 1, totalPages: 2 }),
      },
      {
        match: (u) => u.includes("page=2") && u.includes("/transactions"),
        reply: () =>
          json({ results: [tx("a", "2026-08-10T12:00:00Z", 5, "DEBIT")], page: 2, totalPages: 2 }),
      },
    ]);
    const out = await provider.listTransactions(LIST_PARAMS);
    expect(out.map((t) => t.providerTxId)).toEqual(["a", "b"]); // ordenado por data
  });

  it("filtra transações não-POSTED e não-BRL", async () => {
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/transactions"),
        reply: () =>
          json({
            results: [
              { id: "1", date: "2026-08-10T12:00:00Z", description: "ok", amount: 10, currencyCode: "BRL", type: "CREDIT", status: "POSTED" },
              { id: "2", date: "2026-08-11T12:00:00Z", description: "pendente", amount: 10, currencyCode: "BRL", type: "CREDIT", status: "PENDING" },
              { id: "3", date: "2026-08-12T12:00:00Z", description: "dólar", amount: 10, currencyCode: "USD", type: "CREDIT", status: "POSTED" },
            ],
            page: 1,
            totalPages: 1,
          }),
      },
    ]);
    const out = await provider.listTransactions(LIST_PARAMS);
    expect(out.map((t) => t.providerTxId)).toEqual(["1"]);
  });

  it("converte para centavos com sinal pelo type (DEBIT negativo, CREDIT positivo)", async () => {
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/transactions"),
        reply: () =>
          json({
            results: [
              { id: "c", date: "2026-08-10T12:00:00Z", description: "pix", amount: 1234.56, currencyCode: "BRL", type: "CREDIT", status: "POSTED" },
              // Sinal do float NÃO é confiável: mesmo negativo, CREDIT fica positivo (e vice-versa).
              { id: "d", date: "2026-08-11T12:00:00Z", description: "tarifa", amount: 19.9, currencyCode: "BRL", type: "DEBIT", status: "POSTED" },
            ],
            page: 1,
            totalPages: 1,
          }),
      },
    ]);
    const out = await provider.listTransactions(LIST_PARAMS);
    expect(out.find((t) => t.providerTxId === "c")?.amountCents).toBe(123_456);
    expect(out.find((t) => t.providerTxId === "d")?.amountCents).toBe(-1_990);
  });

  it("converte o instante UTC para o DIA em BRT (America/Sao_Paulo)", async () => {
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/transactions"),
        reply: () =>
          json({
            // 01:00 UTC = 22:00 do dia ANTERIOR em BRT (UTC-3).
            results: [{ id: "e", date: "2026-08-15T01:00:00Z", description: "ted", amount: 1, currencyCode: "BRL", type: "CREDIT", status: "POSTED" }],
            page: 1,
            totalPages: 1,
          }),
      },
    ]);
    const out = await provider.listTransactions(LIST_PARAMS);
    expect(out[0].date).toBe("2026-08-14");
  });

  it("conta local não mapeada em PLUGGY_ACCOUNT_MAP dá erro claro (sem chamar a API)", async () => {
    const { provider, calls } = makeProvider([AUTH_ROUTE]);
    await expect(
      provider.listTransactions({ ...LIST_PARAMS, bankAccountId: "ba_outra" })
    ).rejects.toThrow(/ba_outra.*PLUGGY_ACCOUNT_MAP/);
    expect(calls).toHaveLength(0);
  });

  it("resposta não-ok da API vira ValidationError com status e corpo (sem a apiKey)", async () => {
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/transactions"),
        reply: () => new Response('{"message":"item outdated"}', { status: 400 }),
      },
    ]);
    const err = await provider.listTransactions(LIST_PARAMS).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(String(err.message)).toContain("400");
    expect(String(err.message)).toContain("item outdated");
    expect(String(err.message)).not.toContain("jwt-teste");
  });
});

describe("PluggyBankDataProvider.getBalance", () => {
  it("devolve o saldo em centavos com a data (BRT) do updatedAt — papel do LEDGERBAL", async () => {
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/accounts/acc-uuid-1"),
        reply: () =>
          json({ id: "acc-uuid-1", balance: 15895.51, currencyCode: "BRL", updatedAt: "2026-09-05T02:30:00Z" }),
      },
    ]);
    const balance = await provider.getBalance({ bankAccountId: "ba_itau" });
    expect(balance).toEqual({ amountCents: 1_589_551, date: "2026-09-04" });
  });

  it("conta em moeda estrangeira devolve null (sem saldo de referência)", async () => {
    const { provider } = makeProvider([
      AUTH_ROUTE,
      {
        match: (u) => u.includes("/accounts/acc-uuid-1"),
        reply: () =>
          json({ id: "acc-uuid-1", balance: 100, currencyCode: "USD", updatedAt: "2026-09-05T02:30:00Z" }),
      },
    ]);
    expect(await provider.getBalance({ bankAccountId: "ba_itau" })).toBeNull();
  });
});
