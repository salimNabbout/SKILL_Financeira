/**
 * Âncora externa do head: a linha impressa no log é a cópia que sobrevive a
 * quem tem acesso ao banco.
 */

import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import { buildAnchorLines } from "../../../scripts/audit-anchor";

async function registrar(env: ReturnType<typeof createTestEnv>, quantos: number) {
  for (let i = 0; i < quantos; i++) {
    await env.audit.record(env.company.id, {
      actor: env.actorFor("manager"),
      action: "payable.updated",
      entityType: "payable",
      entityId: `payb_${i}`,
    });
  }
}

describe("buildAnchorLines", () => {
  it("uma linha por empresa, com seq e hash do head e ok=true", async () => {
    const env = createTestEnv();
    await registrar(env, 3);

    const [linha] = await buildAnchorLines(env.repos, env.clock.now());

    expect(linha.companyId).toBe(env.company.id);
    expect(linha.seq).toBe(3);
    const head = await env.repos.audit.getHead(env.company.id);
    expect(linha.hash).toBe(head?.hash);
    expect(linha.ok).toBe(true);
    expect(linha.verifiedAt).toBe(env.clock.now().toISOString());
    expect(linha.brokenAtSeq).toBeUndefined();
  });

  it("trilha vazia: seq 0 e cadeia válida", async () => {
    const env = createTestEnv();

    const [linha] = await buildAnchorLines(env.repos, env.clock.now());

    expect(linha.seq).toBe(0);
    expect(linha.hash).toBe("");
    expect(linha.ok).toBe(true);
  });

  it("truncamento do FIM é denunciado pela âncora (ok=false)", async () => {
    const env = createTestEnv();
    await registrar(env, 3);

    // Alguém apaga o último registro direto no banco — o que sobra ainda é um
    // prefixo válido, então só a âncora denuncia.
    env.db.auditRecords.pop();

    const [linha] = await buildAnchorLines(env.repos, env.clock.now());

    expect(linha.ok).toBe(false);
    expect(linha.brokenAtSeq).toBe(3);
    // A linha continua trazendo o head esperado, que é o que se compara com o log.
    expect(linha.seq).toBe(3);
  });

  it("adulteração de conteúdo também derruba o ok", async () => {
    const env = createTestEnv();
    await registrar(env, 2);

    env.db.auditRecords[0].action = "adulterado";

    const [linha] = await buildAnchorLines(env.repos, env.clock.now());
    expect(linha.ok).toBe(false);
  });

  it("é serializável como uma linha JSON (formato do log)", async () => {
    const env = createTestEnv();
    await registrar(env, 1);

    const [linha] = await buildAnchorLines(env.repos, env.clock.now());
    const json = JSON.stringify(linha);

    expect(json.includes("\n")).toBe(false);
    expect(JSON.parse(json)).toMatchObject({ companyId: env.company.id, ok: true, seq: 1 });
  });
});
