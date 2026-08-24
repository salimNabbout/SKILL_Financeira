"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { CostCenter, CostCenterScope } from "@/core/entities";
import { errorMessage, fdOptional, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/centros-de-custo";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

const SCOPES: CostCenterScope[] = ["payable", "receivable", "both"];

/** Lê o destino do formulário; qualquer valor fora da lista vira "both". */
function lerScope(formData: FormData): CostCenterScope {
  const bruto = fdOptional(formData, "scope");
  return SCOPES.includes(bruto as CostCenterScope) ? (bruto as CostCenterScope) : "both";
}

export async function createCostCenterAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const code = fdString(formData, "code");
  const name = fdString(formData, "name");
  if (!code || !name) fail("Informe código e nome do centro de custo.");
  const scope = lerScope(formData);

  let existing: CostCenter | undefined;
  try {
    existing = (await container.repos.costCenters.listAll(companyId)).find(
      (c) => c.code.toLowerCase() === code.toLowerCase()
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  if (existing) {
    ok(`Centro de custo "${existing.code}" já estava cadastrado — nenhum registro duplicado.`);
  }

  let criado: CostCenter | undefined;
  try {
    const costCenter: CostCenter = {
      id: container.ids.next("cc"),
      companyId,
      code,
      name,
      active: true,
      scope,
    };
    await container.repos.costCenters.create(costCenter);
    criado = costCenter;
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "cost_center.created",
      entityType: "cost_center",
      entityId: costCenter.id,
      after: costCenter,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Centro de custo "${code} — ${name}" cadastrado.`);
}

/**
 * Edita um centro de custo (código, nome, destino e situação).
 *
 * O destino filtra apenas lançamentos NOVOS: títulos já vinculados continuam
 * como estão, mesmo que passem a contrariar o destino escolhido. Desvincular
 * automaticamente apagaria a classificação de contas já lançadas — e ninguém
 * pediu isso ao trocar um filtro de cadastro. Quando o caso ocorre, a mudança
 * é permitida e a mensagem diz quantos títulos seguem vinculados.
 */
export async function updateCostCenterAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Centro de custo não informado.");
  const code = fdString(formData, "code");
  const name = fdString(formData, "name");
  if (!code || !name) fail("Informe código e nome do centro de custo.");
  const scope = lerScope(formData);
  const active = fdOptional(formData, "active") !== "false";

  let mensagem: string;
  try {
    const before = await container.repos.costCenters.getById(companyId, id);
    if (!before) fail("Centro de custo não encontrado.");

    const duplicado = (await container.repos.costCenters.listAll(companyId)).find(
      (c) => c.id !== id && c.code.toLowerCase() === code.toLowerCase()
    );
    if (duplicado) {
      fail(`Já existe um centro de custo com o código "${duplicado.code}".`);
    }

    const after: CostCenter = { ...before, code, name, scope, active };
    await container.repos.costCenters.update(after);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "cost_center.updated",
      entityType: "cost_center",
      entityId: after.id,
      before,
      after,
    });

    mensagem = `Centro de custo "${code} — ${name}" atualizado.`;

    // Avisa (sem bloquear) quando o novo destino contraria títulos já lançados.
    if (before.scope !== scope && scope !== "both") {
      const [payables, receivables] = await Promise.all([
        container.repos.payables.listAll(companyId),
        container.repos.receivables.listAll(companyId),
      ]);
      const vinculadosContrarios =
        scope === "payable"
          ? receivables.filter((r) => r.costCenterId === id).length
          : payables.filter((p) => p.costCenterId === id).length;
      if (vinculadosContrarios > 0) {
        const onde = scope === "payable" ? "a receber" : "a pagar";
        mensagem +=
          ` ${vinculadosContrarios} título(s) ${onde} continuam vinculados a ele:` +
          " o destino vale só para lançamentos novos.";
      }
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  // ok() chama redirect(), que lança NEXT_REDIRECT — precisa ficar FORA do try.
  ok(mensagem);
}
