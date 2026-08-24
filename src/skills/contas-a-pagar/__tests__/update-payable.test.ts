import { describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "@/adapters/memory/test-env";
import type { Payable, Supplier } from "@/core/entities";
import { runSkill } from "@/core/skill";
import { contasAPagarSkill, type UpdatePayableData } from "..";

/**
 * Edição de título a pagar.
 *
 * O que estes testes protegem: o que já teve efeito financeiro não se
 * reescreve. Um título pago foi conciliado com o extrato e entrou no DRE do
 * mês; um título agendado tem aprovação amarrada ao valor. Mudar esses valores
 * depois não é correção — e a segunda situação abriria caminho para burlar a
 * alçada aprovando um valor e publicando outro.
 */

let seq = 0;

function seedSupplier(env: TestEnv): Supplier {
  const now = env.clock.now().toISOString();
  const supplier: Supplier = {
    id: "sup_1",
    companyId: env.company.id,
    name: "Fornecedora Alfa Ltda",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  env.db.suppliers.push(supplier);
  return supplier;
}

function seedPayable(env: TestEnv, over: Partial<Payable> = {}): Payable {
  const now = env.clock.now().toISOString();
  const id = over.id ?? `payb_${++seq}`;
  const payable: Payable = {
    id,
    companyId: env.company.id,
    supplierId: "sup_1",
    description: "Título original",
    issueDate: "2026-08-01",
    dueDate: "2026-08-20",
    amountCents: 50_000,
    paidCents: 0,
    currency: "BRL",
    status: "open",
    installmentNumber: 1,
    installmentCount: 1,
    originKey: `seed:${id}:1/1`,
    createdBy: "usr_analyst",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  env.db.payables.push(payable);
  return payable;
}

async function update(env: TestEnv, input: Record<string, unknown>) {
  return runSkill(contasAPagarSkill, env.ctx(env.actorFor("analyst")), {
    action: "update_payable",
    ...input,
  });
}

describe("contas_a_pagar / update_payable", () => {
  it("edita título em aberto e registra a auditoria com before e after", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env);

    const res = await update(env, {
      payableId: payable.id,
      description: "Título corrigido",
      amountCents: 75_000,
      dueDate: "2026-09-10",
    });

    expect(res.status).toBe("success");
    const data = res.data as UpdatePayableData;
    expect(data.changed).toEqual(
      expect.arrayContaining(["description", "dueDate", "amountCents"])
    );
    expect(env.db.payables[0].amountCents).toBe(75_000);
    expect(env.db.payables[0].description).toBe("Título corrigido");

    const registro = env.db.auditRecords.find((a) => a.action === "payable.updated");
    expect(registro).toBeDefined();
    expect((registro?.before as Payable).amountCents).toBe(50_000);
    expect((registro?.after as Payable).amountCents).toBe(75_000);
  });

  it("recusa alterar valor de título com pagamento registrado", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env, { paidCents: 20_000, status: "partially_paid" });

    const res = await update(env, { payableId: payable.id, amountCents: 90_000 });

    expect(res.status).toBe("error");
    expect(env.db.payables[0].amountCents).toBe(50_000);
  });

  it("recusa alterar valor de título agendado (a aprovação já foi dada sobre o valor antigo)", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env, { status: "scheduled" });

    const res = await update(env, { payableId: payable.id, amountCents: 6_000_000 });

    expect(res.status).toBe("error");
    expect(env.db.payables[0].amountCents).toBe(50_000);
  });

  it("permite reclassificar (descrição) mesmo com pagamento registrado", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env, { paidCents: 20_000, status: "partially_paid" });

    const res = await update(env, { payableId: payable.id, description: "Reclassificado" });

    expect(res.status).toBe("success");
    expect(env.db.payables[0].description).toBe("Reclassificado");
    expect(env.db.payables[0].paidCents).toBe(20_000);
  });

  it("recusa vencimento anterior à emissão, com a mesma mensagem da criação", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env);

    const res = await update(env, {
      payableId: payable.id,
      issueDate: "2026-08-10",
      dueDate: "2026-08-01",
    });

    expect(res.status).toBe("error");
    expect(res.alerts?.[0]?.message).toContain("Verificar a Data da Emissão");
    expect(env.db.payables[0].dueDate).toBe("2026-08-20");
  });

  it("recusa editar título cancelado", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env, { status: "canceled" });

    const res = await update(env, { payableId: payable.id, description: "Qualquer" });

    expect(res.status).toBe("error");
    expect(env.db.payables[0].description).toBe("Título original");
  });

  it("sem mudança real não escreve nem audita", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env);

    const res = await update(env, {
      payableId: payable.id,
      description: payable.description,
      amountCents: payable.amountCents,
    });

    expect(res.status).toBe("success");
    expect((res.data as UpdatePayableData).changed).toHaveLength(0);
    expect(env.db.auditRecords.some((a) => a.action === "payable.updated")).toBe(false);
  });

  it("recusa centro de custo inexistente", async () => {
    const env = createTestEnv();
    seedSupplier(env);
    const payable = seedPayable(env);

    const res = await update(env, { payableId: payable.id, costCenterId: "cc_inexistente" });

    expect(res.status).toBe("error");
  });
});
