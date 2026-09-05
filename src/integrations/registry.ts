/**
 * Seleção de provedores por variável de ambiente. Default: mock em tudo.
 * Um provedor real declarado mas não implementado/configurado falha ALTO na
 * inicialização (nunca silenciosamente cai no mock) — princípio: mocks são
 * sempre explícitos, nunca um fallback disfarçado.
 */

import { ValidationError } from "@/core/errors";
import {
  MockBankDataProvider,
  MockChargeProvider,
  MockFiscalProvider,
  MockMessagingProvider,
} from "./mock";
import {
  PluggyBankDataProvider,
  readPluggyConfig,
} from "./providers/pluggy-bank-data-provider";
import type { BankDataProvider, Integrations } from "@/core/integrations";

export type IntegrationsEnv = Record<string, string | undefined>;

function assertMockOnly(name: string, value: string | undefined): void {
  const selected = (value ?? "mock").toLowerCase();
  if (selected !== "mock") {
    // Ponto de extensão: cada provedor real registra-se aqui (o de dados
    // bancários já tem seleção própria em buildBankDataProvider).
    throw new ValidationError(
      `${name}="${selected}" ainda não implementado — provedores reais entram com credenciais; use "mock" ou remova a variável.`
    );
  }
}

/** Dados bancários: mock (default) ou Pluggy — sem credenciais, falha ALTO. */
function buildBankDataProvider(env: IntegrationsEnv): BankDataProvider {
  const selected = (env.INTEGRATION_BANK ?? "mock").toLowerCase();
  if (selected === "mock") return new MockBankDataProvider();
  if (selected === "pluggy") return new PluggyBankDataProvider(readPluggyConfig(env));
  throw new ValidationError(
    `INTEGRATION_BANK="${selected}" não suportado — use "mock" ou "pluggy".`
  );
}

export function buildIntegrations(env: IntegrationsEnv = process.env): Integrations {
  assertMockOnly("INTEGRATION_CHARGES", env.INTEGRATION_CHARGES);
  assertMockOnly("INTEGRATION_FISCAL", env.INTEGRATION_FISCAL);
  assertMockOnly("INTEGRATION_MESSAGING", env.INTEGRATION_MESSAGING);
  return {
    bankData: buildBankDataProvider(env),
    charges: new MockChargeProvider(),
    fiscal: new MockFiscalProvider(),
    messaging: new MockMessagingProvider(),
  };
}
