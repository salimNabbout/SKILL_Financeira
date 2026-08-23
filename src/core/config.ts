/**
 * Configuração por empresa — políticas como DADOS, nunca hardcode.
 * Inclui alçadas, juros/multa padrão, régua de cobrança e regras tributárias
 * configuráveis (a validação final é sempre de um contador).
 */

import type { LateFeePolicy } from "./money";
import type { RoleName } from "./entities";
import type { CollectionChannel } from "./entities";
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from "./password-policy";
import { DEFAULT_SCHEDULES, type ScheduleDefinition } from "./scheduler";

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
  /** Rotinas agendadas (executadas pelo scripts/scheduler.ts, quando ativo). */
  schedules: ScheduleDefinition[];
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
  schedules: DEFAULT_SCHEDULES,
  reconciliationAutoConfirmThreshold: 0.9,
  reconciliationAmountToleranceCents: 100, // R$ 1,00
  reconciliationDateToleranceDays: 3,
  taxRules: {
    regime: "simples_nacional",
    observacao:
      "Regras tributárias são dados de configuração e exigem validação de contador. Nenhuma alíquota é fixada em código.",
  },
};

/**
 * Ordena as alçadas por teto crescente (sem teto = null vai por último), para
 * que a busca "primeira faixa que cabe" seja correta independentemente da ordem
 * em que os tiers foram persistidos (evita escalonamento de alçada por má
 * configuração — o menor papel jamais cobre um valor acima de sua faixa).
 */
function sortedTiers(tiers: ApprovalTier[]): ApprovalTier[] {
  return [...tiers].sort((a, b) => {
    if (a.maxAmountCents === null) return 1;
    if (b.maxAmountCents === null) return -1;
    return a.maxAmountCents - b.maxAmountCents;
  });
}

/** Resolve o papel mínimo exigido para aprovar um valor, conforme alçadas. */
export function requiredRoleForAmount(config: CompanyConfig, amountCents: number): RoleName {
  for (const tier of sortedTiers(config.approvalTiers)) {
    if (tier.maxAmountCents === null || amountCents <= tier.maxAmountCents) {
      return tier.requiredRole;
    }
  }
  return "admin";
}

/** Total de aprovações humanas exigidas para o valor (dupla aprovação por faixa). */
export function requiredApprovalsForAmount(config: CompanyConfig, amountCents: number): number {
  for (const tier of sortedTiers(config.approvalTiers)) {
    if (tier.maxAmountCents === null || amountCents <= tier.maxAmountCents) {
      return Math.max(1, tier.approvalsRequired ?? 1);
    }
  }
  return 1;
}

const VALID_TIMEZONES: ReadonlySet<string> = (() => {
  try {
    return new Set(Intl.supportedValuesOf("timeZone"));
  } catch {
    // Ambientes sem Intl.supportedValuesOf: não valida (retorna set vazio → aceita tudo).
    return new Set<string>();
  }
})();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTier(value: unknown): value is ApprovalTier {
  if (!isPlainObject(value)) return false;
  const max = value.maxAmountCents;
  const maxOk = max === null || (typeof max === "number" && Number.isFinite(max) && max >= 0);
  return maxOk && typeof value.requiredRole === "string";
}

/**
 * Mescla configuração persistida (JSON da empresa) com defaults, com validação
 * defensiva: objetos aninhados fazem merge por CAMPO (não substituem o objeto
 * inteiro), valores inválidos caem no default e o timezone é validado. Assim
 * uma config parcial nunca introduz undefined/NaN nos cálculos financeiros.
 */
export function resolveCompanyConfig(raw: unknown): CompanyConfig {
  if (!isPlainObject(raw)) return DEFAULT_COMPANY_CONFIG;
  const d = DEFAULT_COMPANY_CONFIG;
  const r = raw as Partial<CompanyConfig>;

  const timezone =
    typeof r.timezone === "string" &&
    (VALID_TIMEZONES.size === 0 || VALID_TIMEZONES.has(r.timezone))
      ? r.timezone
      : d.timezone;

  const approvalTiers =
    Array.isArray(r.approvalTiers) && r.approvalTiers.length > 0 && r.approvalTiers.every(isValidTier)
      ? (r.approvalTiers as ApprovalTier[])
      : d.approvalTiers;

  const lateFeeDefaults = isPlainObject(r.lateFeeDefaults)
    ? { ...d.lateFeeDefaults, ...(r.lateFeeDefaults as Partial<LateFeePolicy>) }
    : d.lateFeeDefaults;

  const dunningSteps =
    Array.isArray(r.dunningSteps) && r.dunningSteps.length > 0
      ? (r.dunningSteps as DunningStep[])
      : d.dunningSteps;

  // Agendas: a lista da empresa tem precedência (customizações preservadas),
  // mas as agendas padrão cujo id ela não define são ACRESCENTADAS. Assim,
  // agendas novas do sistema (ex.: recorrência) passam a valer também para
  // empresas com config antigo, sem sobrescrever o que a empresa customizou.
  const schedules =
    Array.isArray(r.schedules) && r.schedules.length > 0
      ? (() => {
          const own = r.schedules as ScheduleDefinition[];
          const ownIds = new Set(own.map((s) => s.id));
          const missing = d.schedules.filter((s) => !ownIds.has(s.id));
          return [...own, ...missing];
        })()
      : d.schedules;

  const passwordPolicy = isPlainObject(r.passwordPolicy)
    ? { ...d.passwordPolicy, ...(r.passwordPolicy as Partial<PasswordPolicy>) }
    : d.passwordPolicy;

  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return {
    timezone,
    currency: typeof r.currency === "string" ? r.currency : d.currency,
    approvalTiers,
    lateFeeDefaults: {
      finePercent: num(lateFeeDefaults.finePercent, d.lateFeeDefaults.finePercent),
      monthlyInterestPercent: num(
        lateFeeDefaults.monthlyInterestPercent,
        d.lateFeeDefaults.monthlyInterestPercent
      ),
    },
    dunningSteps,
    budgetDeviationAlertPercent: num(r.budgetDeviationAlertPercent, d.budgetDeviationAlertPercent),
    minimumCashCents: num(r.minimumCashCents, d.minimumCashCents),
    passwordPolicy,
    schedules,
    reconciliationAutoConfirmThreshold: num(
      r.reconciliationAutoConfirmThreshold,
      d.reconciliationAutoConfirmThreshold
    ),
    reconciliationAmountToleranceCents: num(
      r.reconciliationAmountToleranceCents,
      d.reconciliationAmountToleranceCents
    ),
    reconciliationDateToleranceDays: num(
      r.reconciliationDateToleranceDays,
      d.reconciliationDateToleranceDays
    ),
    taxRules: isPlainObject(r.taxRules) ? (r.taxRules as Record<string, unknown>) : d.taxRules,
  };
}
