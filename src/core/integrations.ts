/**
 * PORTAS de integração externa (v1.2) — contratos que os provedores reais
 * implementarão. No MVP todos os adaptadores são MOCKS determinísticos e
 * claramente identificados (`provider: "mock"`); nenhum efeito externo ocorre.
 *
 * Seleção por variáveis de ambiente (ver registry.ts e .env.example):
 *   INTEGRATION_BANK | INTEGRATION_CHARGES | INTEGRATION_FISCAL | INTEGRATION_MESSAGING
 */

import type { ISODate } from "./dates";
import type { CollectionChannel, Company, Invoice } from "./entities";

// ---------------------------------------------------------------------------
// 1. Dados bancários (Open Finance / agregador) — extrato automático
// ---------------------------------------------------------------------------

export interface ExternalBankTransaction {
  /** Identificador estável no provedor (vira externalId "sync:<provider>:<id>"). */
  providerTxId: string;
  date: ISODate;
  amountCents: number; // com sinal
  description: string;
}

export interface BankDataProvider {
  readonly provider: string;
  /** Transações da conta desde a data (inclusive), em ordem de data. */
  listTransactions(params: {
    bankAccountId: string;
    bankCode: string;
    accountNumberMasked: string;
    since: ISODate;
    until: ISODate;
  }): Promise<ExternalBankTransaction[]>;
}

// ---------------------------------------------------------------------------
// 2. Cobrança de recebimento (Pix / boleto)
// ---------------------------------------------------------------------------

export type ChargeKind = "pix" | "boleto";

export interface ChargeResult {
  provider: string;
  chargeId: string;
  kind: ChargeKind;
  /** Pix copia-e-cola OU linha digitável do boleto, conforme kind. */
  code: string;
  expiresAt: ISODate;
}

export interface ChargeProvider {
  readonly provider: string;
  createCharge(params: {
    kind: ChargeKind;
    amountCents: number;
    dueDate: ISODate;
    customerName: string;
    customerDocument?: string;
    receivableId: string;
  }): Promise<ChargeResult>;
}

// ---------------------------------------------------------------------------
// 3. Emissão fiscal (NF-e / NFS-e)
// ---------------------------------------------------------------------------

export interface FiscalIssueResult {
  provider: string;
  number: string;
  accessKey: string; // 44 dígitos
  issuedAt: string; // ISO-8601
}

export interface FiscalProvider {
  readonly provider: string;
  issueInvoice(params: {
    invoice: Pick<Invoice, "id" | "description" | "totalCents" | "saleRef">;
    company: Pick<Company, "id" | "cnpj" | "name">;
    sequential: number;
    issuedAtIso: string;
  }): Promise<FiscalIssueResult>;
}

// ---------------------------------------------------------------------------
// 4. Mensageria (e-mail / WhatsApp) — régua de cobrança
// ---------------------------------------------------------------------------

export interface MessageSendResult {
  provider: string;
  messageId: string;
  status: "sent" | "queued";
}

export interface MessagingProvider {
  readonly provider: string;
  send(params: {
    channel: CollectionChannel;
    to: string;
    subject: string;
    body: string;
  }): Promise<MessageSendResult>;
}

// ---------------------------------------------------------------------------
// Registro agregado disponível às skills via ctx.integrations
// ---------------------------------------------------------------------------

export interface Integrations {
  bankData: BankDataProvider;
  charges: ChargeProvider;
  fiscal: FiscalProvider;
  messaging: MessagingProvider;
}
