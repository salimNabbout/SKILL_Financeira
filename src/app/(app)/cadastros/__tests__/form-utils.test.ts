import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { buildRegistry } from "@/skills";
import { verifyChain } from "@/core/audit";
import {
  brDateToISO,
  maskAccountNumber,
  parseBRLToCents,
  parseInstallmentsSpec,
} from "../_lib/form-utils";

describe("parseBRLToCents", () => {
  it("converte formatos pt-BR comuns para centavos exatos", () => {
    expect(parseBRLToCents("1.234,56")).toBe(123456);
    expect(parseBRLToCents("1234,56")).toBe(123456);
    expect(parseBRLToCents("R$ 2.500,00")).toBe(250000);
    expect(parseBRLToCents("R$2500")).toBe(250000);
    expect(parseBRLToCents("0,50")).toBe(50);
    expect(parseBRLToCents("0,5")).toBe(50);
    expect(parseBRLToCents("1000")).toBe(100000);
    expect(parseBRLToCents("1.234.567,89")).toBe(123456789);
  });

  it("interpreta ponto como milhar (3 dígitos) ou decimal (1-2 dígitos)", () => {
    expect(parseBRLToCents("1.234")).toBe(123400); // R$ 1.234,00
    expect(parseBRLToCents("1.234.567")).toBe(123456700);
    expect(parseBRLToCents("1234.56")).toBe(123456); // decimal em estilo en
    expect(parseBRLToCents("10.5")).toBe(1050);
  });

  it("aceita valores negativos (saldo inicial)", () => {
    expect(parseBRLToCents("-100,00")).toBe(-10000);
    expect(parseBRLToCents("-1.000")).toBe(-100000);
  });

  it("não usa float: valores com centavos problemáticos ficam exatos", () => {
    // 19,99 * 100 = 1998.9999... em float; aqui deve ser exatamente 1999.
    expect(parseBRLToCents("19,99")).toBe(1999);
    expect(parseBRLToCents("0,29")).toBe(29);
    expect(parseBRLToCents("1.005,10")).toBe(100510);
  });

  it("rejeita entradas inválidas ou ambíguas", () => {
    expect(() => parseBRLToCents("")).toThrow();
    expect(() => parseBRLToCents("abc")).toThrow();
    expect(() => parseBRLToCents("10,999")).toThrow(); // 3 casas com vírgula
    expect(() => parseBRLToCents("1,2,3")).toThrow();
    expect(() => parseBRLToCents("R$")).toThrow();
  });
});

describe("brDateToISO", () => {
  it("converte dd/mm/aaaa para ISODate", () => {
    expect(brDateToISO("15/09/2026")).toBe("2026-09-15");
    expect(brDateToISO("01/01/2027")).toBe("2027-01-01");
  });

  it("rejeita formatos e datas inexistentes", () => {
    expect(() => brDateToISO("2026-09-15")).toThrow();
    expect(() => brDateToISO("31/02/2026")).toThrow();
    expect(() => brDateToISO("15/13/2026")).toThrow();
  });
});

describe("parseInstallmentsSpec", () => {
  it("interpreta o plano dd/mm/aaaa=valor;...", () => {
    const plan = parseInstallmentsSpec("15/09/2026=1.250,00; 15/10/2026=1.250,00");
    expect(plan).toEqual([
      { dueDate: "2026-09-15", amountCents: 125000 },
      { dueDate: "2026-10-15", amountCents: 125000 },
    ]);
  });

  it("retorna lista vazia para entrada vazia e ignora itens em branco", () => {
    expect(parseInstallmentsSpec("")).toEqual([]);
    expect(parseInstallmentsSpec(" ; ;")).toEqual([]);
  });

  it("rejeita itens sem '=' ou com valor não positivo", () => {
    expect(() => parseInstallmentsSpec("15/09/2026")).toThrow();
    expect(() => parseInstallmentsSpec("15/09/2026=0")).toThrow();
    expect(() => parseInstallmentsSpec("15/09/2026=-10,00")).toThrow();
  });
});

describe("maskAccountNumber", () => {
  it("guarda apenas os 4 últimos dígitos", () => {
    expect(maskAccountNumber("45678-9")).toBe("****-6789");
    expect(maskAccountNumber("12345678")).toBe("****-5678");
    expect(maskAccountNumber("0001")).toBe("****-0001");
  });

  it("rejeita números curtos demais", () => {
    expect(() => maskAccountNumber("12")).toThrow();
    expect(() => maskAccountNumber("a-b")).toThrow();
  });
});

describe("integração: valores parseados alimentam o fluxo customer_invoice_intake", () => {
  it("cria títulos a receber com centavos exatos e é idempotente no reenvio", async () => {
    const env = createTestEnv();
    const orchestrator = env.orchestrator(buildRegistry());
    const now = env.clock.now().toISOString();
    await env.repos.customers.create({
      id: "cus_1",
      companyId: env.company.id,
      name: "Cliente Teste",
      active: true,
      createdAt: now,
      updatedAt: now,
    });

    const totalCents = parseBRLToCents("2.500,00");
    const installments = parseInstallmentsSpec("15/09/2026=1.250,00;15/10/2026=1.250,00");
    expect(installments.reduce((acc, i) => acc + i.amountCents, 0)).toBe(totalCents);

    const request = {
      flow: "customer_invoice_intake",
      companyId: env.company.id,
      actor: env.actorFor("analyst"),
      payload: {
        customerId: "cus_1",
        description: "Pedido 1024",
        totalCents,
        issue: true,
        installments,
      },
    };
    const response = await orchestrator.execute(request);
    expect(response.status).toBe("completed");

    const receivables = await env.repos.receivables.listAll(env.company.id);
    expect(receivables).toHaveLength(2);
    expect(receivables.map((r) => r.amountCents).sort()).toEqual([125000, 125000]);
    expect(receivables.map((r) => r.dueDate).sort()).toEqual(["2026-09-15", "2026-10-15"]);

    // Reenvio idêntico (duplo clique no formulário): replay de idempotência, nada duplicado.
    const replay = await orchestrator.execute(request);
    expect(replay.idempotent_replay).toBe(true);
    expect(await env.repos.receivables.listAll(env.company.id)).toHaveLength(2);

    // A trilha de auditoria permanece íntegra (card de verificação da página /auditoria).
    const audit = await env.repos.audit.list(env.company.id);
    expect(audit.length).toBeGreaterThan(0);
    expect(verifyChain(audit)).toEqual({ valid: true });
  });
});
