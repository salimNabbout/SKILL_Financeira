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
import type { Integrations } from "@/core/integrations";

export type IntegrationsEnv = Record<string, string | undefined>;

function assertMockOnly(name: string, value: string | undefined): void {
  const selected = (value ?? "mock").toLowerCase();
  if (selected !== "mock") {
    // Ponto de extensão da v1.2: cada provedor real registra-se aqui
    // (ex.: INTEGRATION_BANK=pluggy → new PluggyBankDataProvider(credenciais)).
    throw new ValidationError(
      `${name}="${selected}" ainda não implementado — provedores reais entram na v1.2 com credenciais; use "mock" ou remova a variável.`
    );
  }
}

export function buildIntegrations(env: IntegrationsEnv = process.env): Integrations {
  assertMockOnly("INTEGRATION_BANK", env.INTEGRATION_BANK);
  assertMockOnly("INTEGRATION_CHARGES", env.INTEGRATION_CHARGES);
  assertMockOnly("INTEGRATION_FISCAL", env.INTEGRATION_FISCAL);
  assertMockOnly("INTEGRATION_MESSAGING", env.INTEGRATION_MESSAGING);
  return {
    bankData: new MockBankDataProvider(),
    charges: new MockChargeProvider(),
    fiscal: new MockFiscalProvider(),
    messaging: new MockMessagingProvider(),
  };
}
