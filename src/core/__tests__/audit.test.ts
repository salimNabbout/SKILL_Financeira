import { describe, expect, it } from "vitest";
import { createTestEnv } from "@/adapters/memory/test-env";
import type { AuditRecord } from "@/core/entities";
import type { AuditRepo } from "@/core/repositories";
import { FixedClock } from "@/core/clock";
import { SequentialIdGenerator } from "@/core/ids";
import { HashChainAuditTrail, verifyChain } from "../audit";

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

  it("record() persiste a âncora do head e detecta truncamento do fim de ponta a ponta", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 3; i++) {
      await env.audit.record(env.company.id, {
        actor: { type: "user", id: "usr_admin" },
        action: `teste.acao${i}`,
        entityType: "X",
        entityId: String(i),
      });
    }
    const records = await env.repos.audit.list(env.company.id);
    const head = await env.repos.audit.getHead(env.company.id);
    expect(head).not.toBeNull();
    expect(head!.seq).toBe(records[2].seq);
    expect(head!.hash).toBe(records[2].hash);

    // Truncando o último registro, a verificação com o head persistido acusa.
    const truncated = records.slice(0, 2);
    expect(verifyChain(truncated, head ?? undefined).valid).toBe(false);
    // A trilha íntegra continua válida contra o head.
    expect(verifyChain(records, head ?? undefined).valid).toBe(true);
  });

  it("detecta remoção do último registro via âncora do head esperado (C2)", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 3; i++) {
      await env.audit.record(env.company.id, {
        actor: { type: "user", id: "usr_admin" },
        action: `teste.acao${i}`,
        entityType: "X",
        entityId: String(i),
      });
    }
    const records = await env.repos.audit.list(env.company.id);
    const head = { seq: records[2].seq, hash: records[2].hash };

    // Sem âncora, um prefixo truncado ainda "valida" — por isso a âncora existe.
    const truncated = records.slice(0, 2);
    expect(verifyChain(truncated).valid).toBe(true);

    // Com a âncora do head esperado, o truncamento do fim é detectado.
    const check = verifyChain(truncated, head);
    expect(check.valid).toBe(false);
    expect(check.brokenAtSeq).toBe(head.seq);
  });

  it("detecta buraco de sequência / cadeia que não começa em 1 (truncamento do início/meio)", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 3; i++) {
      await env.audit.record(env.company.id, {
        actor: { type: "user", id: "usr_admin" },
        action: `teste.acao${i}`,
        entityType: "X",
        entityId: String(i),
      });
    }
    const records = await env.repos.audit.list(env.company.id);

    // Remover o primeiro registro: a cadeia deixa de começar em seq=1.
    const semPrimeiro = records.slice(1);
    expect(verifyChain(semPrimeiro).valid).toBe(false);

    // Remover o do meio: buraco de sequência (1, 3).
    const semMeio = [records[0], records[2]];
    expect(verifyChain(semMeio).valid).toBe(false);
  });

  it("record() recupera de colisão de seq (concorrência) reobtendo o head e refazendo (C1)", async () => {
    // Repo que rejeita append cujo seq já existe (paridade com o unique do Postgres)
    // e que, na primeira leitura de last(), devolve um head DESATUALIZADO — simula
    // duas escritas concorrentes lendo o mesmo head.
    const items: AuditRecord[] = [];
    let lastCalls = 0;
    const repo: AuditRepo = {
      async append(record) {
        if (items.some((r) => r.companyId === record.companyId && r.seq === record.seq)) {
          throw new Error("seq_conflict");
        }
        items.push(record);
      },
      async last(companyId) {
        lastCalls += 1;
        const filtered = items.filter((r) => r.companyId === companyId);
        // 1ª chamada: finge que a cadeia está vazia (head obsoleto) mesmo já
        // havendo um registro seq=1 → força colisão no 1º append e um retry.
        if (lastCalls === 1) return null;
        if (filtered.length === 0) return null;
        return filtered.reduce((a, b) => (a.seq > b.seq ? a : b));
      },
      async list() {
        return [...items];
      },
      async listPage() {
        return { items: [...items], total: items.length, offset: 0, limit: items.length };
      },
      async getHead() {
        return null;
      },
      async setHead() {
        /* no-op no fixture */
      },
    };
    // Pré-existe um registro seq=1 gravado por "outro processo".
    items.push({
      id: "aud_pre",
      companyId: "co_teste",
      seq: 1,
      actorType: "user",
      actorId: "usr_x",
      action: "pre.existente",
      entityType: "X",
      entityId: "0",
      timestamp: "2026-08-18T15:00:00.000Z",
      prevHash: "0".repeat(64),
      hash: "pre",
    } as AuditRecord);

    const audit = new HashChainAuditTrail(repo, new FixedClock("2026-08-18T15:00:00Z"), new SequentialIdGenerator());
    const rec = await audit.record("co_teste", {
      actor: { type: "user", id: "usr_admin" },
      action: "teste.concorrente",
      entityType: "X",
      entityId: "2",
    });

    // O novo registro NÃO colidiu: ganhou seq=2 (após retry), sem bifurcar a cadeia.
    expect(rec.seq).toBe(2);
    const seqs = items.map((r) => r.seq).sort();
    expect(seqs).toEqual([1, 2]);
  });
});
