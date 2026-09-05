/**
 * Adaptador REAL da porta BankDataProvider via Pluggy (agregador Open Finance).
 * https://docs.pluggy.ai — auth por client id/secret; consultas com X-API-KEY.
 *
 * Regras do adaptador:
 *  - só transações POSTED (pendentes ficam de fora até liquidar);
 *  - só BRL (moeda estrangeira geraria centavos ambíguos — descartada com aviso no chamador);
 *  - valores em CENTAVOS com sinal (crédito > 0, débito < 0), derivado do type
 *    DEBIT/CREDIT do Pluggy (não confia no sinal do float);
 *  - datas convertidas para o dia em America/Sao_Paulo (o extrato do banco é BRT);
 *  - getBalance(): saldo atual da conta no Pluggy — equivalente ao <LEDGERBAL>
 *    do OFX; a data de referência é o updatedAt do Pluggy (última atualização).
 *
 * Credenciais SEMPRE via env (ver readPluggyConfig) — nunca em código ou log.
 * O mapeamento conta local → conta Pluggy vem de PLUGGY_ACCOUNT_MAP, pares
 * "idLocal=accountIdPluggy" separados por vírgula.
 */

import { todayInTz, type ISODate } from "@/core/dates";
import { ValidationError } from "@/core/errors";
import type {
  BankDataProvider,
  ExternalBankBalance,
  ExternalBankTransaction,
} from "@/core/integrations";

const DEFAULT_BASE_URL = "https://api.pluggy.ai";
const TZ_BRT = "America/Sao_Paulo";
const PAGE_SIZE = 500;
/** A apiKey do Pluggy vale 2h; renovamos antes disso. */
const API_KEY_TTL_MS = 100 * 60_000;

export interface PluggyConfig {
  clientId: string;
  clientSecret: string;
  /** BankAccount.id local → accountId no Pluggy. */
  accountMap: Record<string, string>;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injetável nos testes; default: fetch global. */
  fetchFn?: typeof fetch;
}

/** Lê e valida a configuração do env. Falha ALTO se algo faltar (nunca cai no mock). */
export function readPluggyConfig(
  env: Record<string, string | undefined> = process.env
): PluggyConfig {
  const clientId = env.PLUGGY_CLIENT_ID;
  const clientSecret = env.PLUGGY_CLIENT_SECRET;
  const mapRaw = env.PLUGGY_ACCOUNT_MAP;
  if (!clientId || !clientSecret || !mapRaw) {
    throw new ValidationError(
      "INTEGRATION_BANK=pluggy exige PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ACCOUNT_MAP definidas."
    );
  }
  const accountMap: Record<string, string> = {};
  for (const pair of mapRaw.split(/[,;]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const local = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    const remote = eq > 0 ? trimmed.slice(eq + 1).trim() : "";
    if (!local || !remote) {
      throw new ValidationError(
        `PLUGGY_ACCOUNT_MAP inválido no trecho "${trimmed}" — formato esperado: idLocal=accountIdPluggy (pares separados por vírgula).`
      );
    }
    accountMap[local] = remote;
  }
  if (Object.keys(accountMap).length === 0) {
    throw new ValidationError("PLUGGY_ACCOUNT_MAP não contém nenhum par idLocal=accountIdPluggy.");
  }
  return { clientId, clientSecret, accountMap };
}

// Formatos de resposta do Pluggy (somente os campos que usamos).
interface PluggyTransaction {
  id: string;
  date: string; // ISO-8601 completo
  description: string;
  amount: number; // em unidades da moeda (float)
  currencyCode: string;
  type: "DEBIT" | "CREDIT";
  status: "PENDING" | "POSTED";
}
interface PluggyTransactionsPage {
  results: PluggyTransaction[];
  page: number;
  totalPages: number;
}
interface PluggyAccount {
  id: string;
  balance: number; // em unidades da moeda (float)
  currencyCode: string;
  updatedAt: string; // ISO-8601
}

/** Float da API (unidades) → centavos inteiros, sem aritmética binária acumulada. */
function toCents(amount: number): number {
  return Math.round(Math.abs(amount) * 100);
}

export class PluggyBankDataProvider implements BankDataProvider {
  readonly provider = "pluggy";

  private readonly config: PluggyConfig;
  private readonly fetchFn: typeof fetch;
  private apiKeyCache: { value: string; obtainedAt: number } | null = null;

  constructor(config: PluggyConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  /** Resolve a conta local no mapa; erro claro quando não mapeada (sem segredos). */
  private accountIdOf(bankAccountId: string): string {
    const remote = this.config.accountMap[bankAccountId];
    if (!remote) {
      throw new ValidationError(
        `Conta bancária ${bankAccountId} não mapeada em PLUGGY_ACCOUNT_MAP — adicione o par ${bankAccountId}=<accountId do Pluggy> (use npm run pluggy:accounts para descobrir o id).`
      );
    }
    return remote;
  }

  /** POST /auth com timeout; nunca inclui credenciais em mensagens de erro. */
  private async authenticate(): Promise<string> {
    const cached = this.apiKeyCache;
    if (cached && Date.now() - cached.obtainedAt < API_KEY_TTL_MS) return cached.value;

    const response = await this.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      }),
    });
    if (!response.ok) {
      throw new ValidationError(
        `Pluggy /auth retornou ${response.status} — verifique PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET.`
      );
    }
    const data = (await response.json()) as { apiKey?: string };
    if (!data.apiKey) {
      throw new ValidationError("Pluggy /auth não devolveu apiKey — resposta inesperada.");
    }
    this.apiKeyCache = { value: data.apiKey, obtainedAt: Date.now() };
    return data.apiKey;
  }

  /** GET autenticado que devolve o JSON ou falha com o corpo do erro (sem a apiKey). */
  private async getJson<T>(path: string): Promise<T> {
    const apiKey = await this.authenticate();
    const response = await this.request(path, { headers: { "X-API-KEY": apiKey } });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ValidationError(
        `Pluggy retornou ${response.status} em ${path.split("?")[0]}: ${detail.slice(0, 300)}`
      );
    }
    return (await response.json()) as T;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      return await this.fetchFn(`${this.baseUrl()}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listTransactions(params: {
    bankAccountId: string;
    bankCode: string;
    accountNumberMasked: string;
    since: ISODate;
    until: ISODate;
  }): Promise<ExternalBankTransaction[]> {
    const accountId = this.accountIdOf(params.bankAccountId);
    const out: ExternalBankTransaction[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const query = new URLSearchParams({
        accountId,
        from: params.since,
        to: params.until,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const data = await this.getJson<PluggyTransactionsPage>(`/transactions?${query}`);
      totalPages = data.totalPages;
      for (const t of data.results) {
        if (t.status !== "POSTED") continue; // pendente: entra quando liquidar
        if (t.currencyCode !== "BRL") continue; // fora do escopo (centavos BRL)
        out.push({
          providerTxId: t.id,
          date: todayInTz(new Date(t.date), TZ_BRT),
          amountCents: t.type === "DEBIT" ? -toCents(t.amount) : toCents(t.amount),
          description: t.description,
        });
      }
      page++;
    } while (page <= totalPages);
    // Contrato da porta: em ordem de data.
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  async getBalance(params: { bankAccountId: string }): Promise<ExternalBankBalance | null> {
    const accountId = this.accountIdOf(params.bankAccountId);
    const account = await this.getJson<PluggyAccount>(`/accounts/${accountId}`);
    if (account.currencyCode !== "BRL") return null;
    const cents = Math.round(account.balance * 100);
    return {
      amountCents: cents,
      date: todayInTz(new Date(account.updatedAt), TZ_BRT),
    };
  }
}
