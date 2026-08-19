/**
 * Adaptadores MOCK das portas de integração — determinísticos, sem nenhum
 * efeito externo, identificados por provider: "mock". Servem para demo, testes
 * e como referência de contrato para os provedores reais da v1.2.
 */

import { createHash } from "node:crypto";
import { addDays, diffDays, type ISODate } from "@/core/dates";
import type {
  BankDataProvider,
  ChargeProvider,
  ChargeResult,
  ExternalBankTransaction,
  FiscalIssueResult,
  FiscalProvider,
  MessageSendResult,
  MessagingProvider,
} from "@/core/integrations";

const MOCK = "mock" as const;

function hashHex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Dígitos determinísticos a partir de um seed (para códigos numéricos fake). */
function hashDigits(seed: string, length: number): string {
  return BigInt(`0x${hashHex(seed)}`).toString(10).padStart(length, "0").slice(0, length);
}

// ---------------------------------------------------------------------------
// 1. Banco (Open Finance/agregador) — extrato sintético determinístico
// ---------------------------------------------------------------------------

const MOCK_TX_TEMPLATES: Array<{ description: string; minCents: number; maxCents: number; credit: boolean }> = [
  { description: "PIX RECEBIDO CLIENTE (SYNC MOCK)", minCents: 15_000, maxCents: 480_000, credit: true },
  { description: "TED RECEBIDA (SYNC MOCK)", minCents: 50_000, maxCents: 900_000, credit: true },
  { description: "PAGTO FORNECEDOR (SYNC MOCK)", minCents: 20_000, maxCents: 600_000, credit: false },
  { description: "TARIFA PACOTE SERVICOS (SYNC MOCK)", minCents: 2_990, maxCents: 8_990, credit: false },
];

/**
 * Gera um extrato sintético estável: os mesmos parâmetros produzem SEMPRE as
 * mesmas transações (o dedupe por externalId fica demonstrável ao sincronizar
 * duas vezes). ~1 transação a cada 2 dias por conta.
 */
export class MockBankDataProvider implements BankDataProvider {
  readonly provider = MOCK;

  async listTransactions(params: {
    bankAccountId: string;
    bankCode: string;
    accountNumberMasked: string;
    since: ISODate;
    until: ISODate;
  }): Promise<ExternalBankTransaction[]> {
    const out: ExternalBankTransaction[] = [];
    const days = Math.max(0, diffDays(params.since, params.until));
    for (let d = 0; d <= days; d++) {
      const date = addDays(params.since, d);
      const daySeed = hashHex(`${params.bankAccountId}:${date}`);
      if (parseInt(daySeed.slice(0, 2), 16) % 2 !== 0) continue; // ~metade dos dias
      const template = MOCK_TX_TEMPLATES[parseInt(daySeed.slice(2, 4), 16) % MOCK_TX_TEMPLATES.length];
      const range = template.maxCents - template.minCents;
      const amount = template.minCents + (parseInt(daySeed.slice(4, 10), 16) % range);
      out.push({
        providerTxId: `mock-${daySeed.slice(0, 16)}`,
        date,
        amountCents: template.credit ? amount : -amount,
        description: template.description,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 2. Cobrança Pix/boleto — códigos fake determinísticos
// ---------------------------------------------------------------------------

export class MockChargeProvider implements ChargeProvider {
  readonly provider = MOCK;

  async createCharge(params: {
    kind: "pix" | "boleto";
    amountCents: number;
    dueDate: ISODate;
    customerName: string;
    customerDocument?: string;
    receivableId: string;
  }): Promise<ChargeResult> {
    const seed = `${params.receivableId}:${params.kind}:${params.amountCents}`;
    const code =
      params.kind === "pix"
        ? // Formato inspirado no BR Code (copia-e-cola) — claramente fake.
          `00020126MOCK${hashDigits(seed, 32)}5204000053039865802BR6304${hashDigits(`${seed}:crc`, 4)}`
        : // Linha digitável de boleto: 47 dígitos fake.
          hashDigits(seed, 47);
    return {
      provider: MOCK,
      chargeId: `chg_${hashHex(seed).slice(0, 12)}`,
      kind: params.kind,
      code,
      expiresAt: params.dueDate,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Fiscal (NF-e/NFS-e) — replica o mock histórico do faturamento
// ---------------------------------------------------------------------------

export class MockFiscalProvider implements FiscalProvider {
  readonly provider = MOCK;

  async issueInvoice(params: {
    invoice: { id: string; description: string; totalCents: number; saleRef?: string };
    company: { id: string; cnpj: string; name: string };
    sequential: number;
    issuedAtIso: string;
  }): Promise<FiscalIssueResult> {
    return {
      provider: MOCK,
      number: `NFE-${params.sequential}`,
      // Mesma derivação usada desde o MVP: determinística por empresa+fatura.
      accessKey: hashDigits(`${params.company.id}:${params.invoice.id}`, 44),
      issuedAt: params.issuedAtIso,
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Mensageria — "envia" sem efeito externo
// ---------------------------------------------------------------------------

export class MockMessagingProvider implements MessagingProvider {
  readonly provider = MOCK;

  async send(params: {
    channel: "email" | "whatsapp_mock" | "letter";
    to: string;
    subject: string;
    body: string;
  }): Promise<MessageSendResult> {
    return {
      provider: MOCK,
      messageId: `msg_${hashHex(`${params.channel}:${params.to}:${params.subject}`).slice(0, 12)}`,
      status: "sent",
    };
  }
}
