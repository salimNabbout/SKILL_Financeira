import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPANY_CONFIG,
  requiredApprovalsForAmount,
  requiredRoleForAmount,
  resolveCompanyConfig,
} from "../config";

describe("resolveCompanyConfig — merge profundo e validação (E1)", () => {
  it("preenche campos aninhados ausentes com o default (sem undefined/NaN)", () => {
    // lateFeeDefaults parcial: só finePercent. monthlyInterestPercent deve vir do default.
    const config = resolveCompanyConfig({ lateFeeDefaults: { finePercent: 5 } });
    expect(config.lateFeeDefaults.finePercent).toBe(5);
    expect(config.lateFeeDefaults.monthlyInterestPercent).toBe(
      DEFAULT_COMPANY_CONFIG.lateFeeDefaults.monthlyInterestPercent
    );
    expect(Number.isFinite(config.lateFeeDefaults.monthlyInterestPercent)).toBe(true);
  });

  it("ignora timezone inválido e mantém o default", () => {
    const config = resolveCompanyConfig({ timezone: "Nao/Existe" });
    expect(config.timezone).toBe(DEFAULT_COMPANY_CONFIG.timezone);
  });

  it("cai no default quando approvalTiers é vazio ou inválido", () => {
    const vazio = resolveCompanyConfig({ approvalTiers: [] });
    expect(vazio.approvalTiers).toEqual(DEFAULT_COMPANY_CONFIG.approvalTiers);
    const invalido = resolveCompanyConfig({ approvalTiers: "lixo" as unknown });
    expect(invalido.approvalTiers).toEqual(DEFAULT_COMPANY_CONFIG.approvalTiers);
  });
});

describe("requiredRoleForAmount — robusto à ordem dos tiers (E2)", () => {
  it("exige o papel correto mesmo com tiers persistidos fora de ordem", () => {
    // Tiers embaralhados: o de valor null (sem teto) vem primeiro.
    const config = resolveCompanyConfig({
      approvalTiers: [
        { maxAmountCents: null, requiredRole: "admin" },
        { maxAmountCents: 500_000, requiredRole: "approver" },
        { maxAmountCents: 5_000_000, requiredRole: "finance_manager" },
      ],
    });
    // R$ 10 milhões deve exigir admin (sem teto), não approver.
    expect(requiredRoleForAmount(config, 1_000_000_000)).toBe("admin");
    // R$ 4.999 deve exigir approver (menor faixa).
    expect(requiredRoleForAmount(config, 499_900)).toBe("approver");
    // R$ 40.000 deve exigir finance_manager (faixa intermediária).
    expect(requiredRoleForAmount(config, 4_000_000)).toBe("finance_manager");
  });

  it("valor negativo ou zero cai na menor faixa sem quebrar", () => {
    const config = DEFAULT_COMPANY_CONFIG;
    expect(requiredRoleForAmount(config, 0)).toBe("approver");
    expect(requiredRoleForAmount(config, -1)).toBe("approver");
  });

  it("requiredApprovalsForAmount também respeita a ordenação", () => {
    const config = resolveCompanyConfig({
      approvalTiers: [
        { maxAmountCents: null, requiredRole: "admin", approvalsRequired: 2 },
        { maxAmountCents: 500_000, requiredRole: "approver" },
      ],
    });
    expect(requiredApprovalsForAmount(config, 499_900)).toBe(1);
    expect(requiredApprovalsForAmount(config, 1_000_000_000)).toBe(2);
  });
});
