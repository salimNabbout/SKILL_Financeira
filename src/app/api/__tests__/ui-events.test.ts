import { describe, expect, it } from "vitest";
import { registerUiEvents } from "@/app/api/_lib/ui-events";
import { ValidationError } from "@/core/errors";
import { createTestEnv } from "@/adapters/memory/test-env";

function makeSession(env: ReturnType<typeof createTestEnv>) {
  return { user: env.users.analyst, company: env.company };
}

describe("POST /api/v1/ui-events (registerUiEvents)", () => {
  it("grava o lote com origem frontend, usuário da sessão e IP/UA da requisição", async () => {
    const env = createTestEnv();
    const result = await registerUiEvents(
      env.activity,
      makeSession(env),
      {
        eventos: [
          { tipo: "clique", tela: "/contas-a-pagar", rotulo: "Novo título", elemento: "nt_abrir" },
          { tipo: "navegacao", tela: "/auditoria" },
        ],
      },
      { ip: "10.0.0.1", userAgent: "Vitest/1.0" }
    );
    expect(result).toEqual({ recebidos: 2 });
    expect(env.db.activityEvents).toHaveLength(2);
    const [clique, nav] = env.db.activityEvents;
    expect(clique.origin).toBe("frontend");
    expect(clique.eventType).toBe("clique");
    expect(clique.userId).toBe(env.users.analyst.id);
    expect(clique.companyId).toBe(env.company.id);
    expect(clique.label).toBe("Novo título");
    expect(clique.elementId).toBe("nt_abrir");
    expect(clique.ip).toBe("10.0.0.1");
    expect(clique.userAgent).toBe("Vitest/1.0");
    expect(nav.eventType).toBe("navegacao");
    expect(nav.screen).toBe("/auditoria");
  });

  it("mascara chaves sensíveis nos detalhes antes de gravar", async () => {
    const env = createTestEnv();
    await registerUiEvents(env.activity, makeSession(env), {
      eventos: [
        {
          tipo: "submissao",
          tela: "/seguranca",
          detalhes: { form: "trocar-senha", senha: "vazou?", token: "abc" },
        },
      ],
    });
    const detalhes = env.db.activityEvents[0].details as Record<string, unknown>;
    expect(detalhes.form).toBe("trocar-senha");
    expect(detalhes.senha).toBe("***");
    expect(detalhes.token).toBe("***");
  });

  it("rejeita tipo desconhecido, lote vazio e lote acima de 50", async () => {
    const env = createTestEnv();
    const session = makeSession(env);
    await expect(
      registerUiEvents(env.activity, session, {
        eventos: [{ tipo: "mousemove", tela: "/x" }],
      })
    ).rejects.toThrow(ValidationError);
    await expect(
      registerUiEvents(env.activity, session, { eventos: [] })
    ).rejects.toThrow(ValidationError);
    await expect(
      registerUiEvents(env.activity, session, {
        eventos: Array.from({ length: 51 }, () => ({ tipo: "clique", tela: "/x" })),
      })
    ).rejects.toThrow(ValidationError);
    expect(env.db.activityEvents).toHaveLength(0);
  });

  it("ignora usuário/empresa que o cliente tente injetar (sempre da sessão)", async () => {
    const env = createTestEnv();
    await registerUiEvents(env.activity, makeSession(env), {
      eventos: [
        // Campos extras (userId/companyId) não fazem parte do schema e são descartados.
        { tipo: "clique", tela: "/x", userId: "usr_intruso", companyId: "co_intrusa" },
      ],
    });
    expect(env.db.activityEvents[0].userId).toBe(env.users.analyst.id);
    expect(env.db.activityEvents[0].companyId).toBe(env.company.id);
  });
});
