import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { verifyChain } from "../audit";

describe("trilha de auditoria", () => {
  it("encadeia hashes e detecta adulteração", async () => {
    const env = createTestEnv();
    await env.audit.record(env.company.id, {
      actor: { type: "user", id: "usr_admin" },
      action: "teste.acao1",
      entityType: "X",
      entityId: "1",
    });
    await env.audit.record(env.company.id, {
      actor: { type: "user", id: "usr_admin" },
      action: "teste.acao2",
      entityType: "X",
      entityId: "2",
      after: { valor: 10 },
    });

    const records = await env.repos.audit.list(env.company.id);
    expect(records).toHaveLength(2);
    expect(verifyChain(records).valid).toBe(true);

    // Adulteração: mudar o conteúdo de um registro quebra a cadeia.
    records[0].action = "teste.adulterada";
    const check = verifyChain(records);
    expect(check.valid).toBe(false);
    expect(check.brokenAtSeq).toBe(1);
  });
});
