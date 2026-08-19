/**
 * Configuração por empresa — políticas como DADOS, nunca hardcode.
 * Inclui alçadas, juros/multa padrão, régua de cobrança e regras tributárias
 * configuráveis (a validação final é sempre de um contador).
 */

import type { LateFeePolicy } from "./money";
import type { RoleName } from "./entities";
import type { CollectionChannel } from "./entities";
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from "./password-policy";

export interface ApprovalTier {
  /** Até este valor (centavos), o papel indicado pode aprovar. null = sem teto. */
  maxAmountCents: number | null;
  requiredRole: RoleName;
  /** Dupla aprovação (four-eyes): aprovações exigidas nesta faixa. Ausente = 1. */
  approvalsRequired?: number;
}

export interface DunningStep {
  daysOverdue: number;
  channel: CollectionChannel;
  /** Template com placeholders {{cliente}}, {{valor}}, {{vencimento}}, {{dias_atraso}}, {{empresa}}. */
  template: string;
  subject: string;
}

export interface CompanyConfig {
  timezone: string;
  currency: string;
  /** Alçadas de aprovação de pagamento, ordenadas por valor crescente. */
  approvalTiers: ApprovalTier[];
  lateFeeDefaults: LateFeePolicy;
  /** Régua de cobrança configurável. */
  dunningSteps: DunningStep[];
  /** Alerta de desvio orçamentário quando |realizado - orçado| / orçado excede (%). */
  budgetDeviationAlertPercent: number;
  /** Caixa mínimo de segurança (centavos) para alertas de insuficiência. */
  minimumCashCents: number;
  /** Política de senha aplicada ao definir/trocar senhas (nunca no login). */
  passwordPolicy: PasswordPolicy;
  /** Conciliação automática exige confiança >= este valor; abaixo vira sugestão. */
  reconciliationAutoConfirmThreshold: number;
  /** Tolerância de valor (centavos) e de dias na conciliação. */
  reconciliationAmountToleranceCents: number;
  reconciliationDateToleranceDays: number;
  /**
   * Regras tributárias como dados configuráveis (ex.: alíquotas por regime).
   * O sistema NUNCA fixa alíquota em código; a validação é do contador.
   */
  taxRules: Record<string, unknown>;
}

export const DEFAULT_COMPANY_CONFIG: CompanyConfig = {
  timezone: "America/Sao_Paulo",
  currency: "BRL",
  approvalTiers: [
    { maxAmountCents: 500_000, requiredRole: "approver" }, // até R$ 5.000
    { maxAmountCents: 5_000_000, requiredRole: "finance_manager" }, // até R$ 50.000
    { maxAmountCents: null, requiredRole: "admin" },
  ],
  lateFeeDefaults: { finePercent: 2, monthlyInterestPercent: 1 },
  dunningSteps: [
    {
      daysOverdue: 3,
      channel: "email",
      subject: "Lembrete de vencimento — {{empresa}}",
      template:
        "Olá, {{cliente}}. Identificamos que o título de {{valor}} com vencimento em {{vencimento}} está em aberto há {{dias_atraso}} dias. Se o pagamento já foi feito, desconsidere. Qualquer dúvida, estamos à disposição.",
    },
    {
      daysOverdue: 10,
      channel: "email",
      subject: "Título em aberto — {{empresa}}",
      template:
        "Olá, {{cliente}}. O título de {{valor}} venceu em {{vencimento}} e segue em aberto ({{dias_atraso}} dias). Podemos ajudar com uma renegociação ou segunda via. Conte conosco.",
    },
    {
      daysOverdue: 30,
      channel: "email",
      subject: "Regularização de pendência — {{empresa}}",
      template:
        "Olá, {{cliente}}. Não identificamos o pagamento do título de {{valor}} vencido em {{vencimento}} ({{dias_atraso}} dias). Gostaríamos de encontrar juntos uma solução. Entre em contato para negociarmos condições.",
    },
  ],
  budgetDeviationAlertPercent: 10,
  minimumCashCents: 1_000_000, // R$ 10.000
  passwordPolicy: DEFAULT_PASSWORD_POLICY,
  reconciliationAutoConfirmThreshold: 0.9,
  reconciliationAmountToleranceCents: 100, // R$ 1,00
  reconciliationDateToleranceDays: 3,
  taxRules: {
    regime: "simples_nacional",
    observacao:
      "Regras tributárias são dados de configuração e exigem validação de contador. Nenhuma alíquota é fixada em código.",
  },
};

/** Resolve o papel mínimo exigido para aprovar um valor, conforme alçadas. */
export function requiredRoleForAmount(config: CompanyConfig, amountCents: number): RoleName {
  for (const tier of config.approvalTiers) {
    if (tier.maxAmountCents === null || amountCents <= tier.maxAmountCents) {
      return tier.requiredRole;
    }
  }
  return "admin";
}

/** Total de aprovações humanas exigidas para o valor (dupla aprovação por faixa). */
export function requiredApprovalsForAmount(config: CompanyConfig, amountCents: number): number {
  for (const tier of config.approvalTiers) {
    if (tier.maxAmountCents === null || amountCents <= tier.maxAmountCents) {
      return Math.max(1, tier.approvalsRequired ?? 1);
    }
  }
  return 1;
}

/** Mescla configuração persistida (JSON da empresa) com defaults. */
export function resolveCompanyConfig(raw: unknown): CompanyConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_COMPANY_CONFIG;
  return { ...DEFAULT_COMPANY_CONFIG, ...(raw as Partial<CompanyConfig>) };
}
