"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { CostCenter, CostCenterScope } from "@/core/entities";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";
import {
  setCostCenterActive,
  updateCostCenterFields,
  countLinkedAgainstScope,
} from "./_lib/update";

const PATH = "/cadastros/centros-de-custo";

const SCOPES: CostCenterScope[] = ["payable", "receivable", "both"];

/** Lê o destino do formulário; valor fora da lista vira "both". */
function lerScope(formData: FormData): CostCenterScope {
  const bruto = fdString(formData, "scope");
  return SCOPES.includes(bruto as CostCenterScope) ? (bruto as CostCenterScope) : "both";
}

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
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

export async function updateCostCenterAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Centro de custo inválido para edição.");
  const code = fdString(formData, "code");
  const name = fdString(formData, "name");

  const scope = lerScope(formData);

  let after;
  let vinculadosContrarios = 0;
  try {
    const result = await updateCostCenterFields(container, companyId, id, { code, name, scope });
    after = result.after;
    // Mudar o destino NÃO desvincula nada: avisa quantos lançamentos do lado
    // oposto continuam apontando para este centro.
    if (result.before.scope !== after.scope) {
      vinculadosContrarios = await countLinkedAgainstScope(container, companyId, id, after.scope);
    }
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "cost_center.updated",
      entityType: "cost_center",
      entityId: after.id,
      before: result.before,
      after: result.after,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  // ok() lança NEXT_REDIRECT — precisa ficar FORA do try, senão o catch o
  // captura e o exibe como erro.
  ok(
    vinculadosContrarios > 0
      ? `Centro de custo "${after.code} — ${after.name}" atualizado. ${vinculadosContrarios} lançamento(s) existentes continuam vinculados: o destino vale só para lançamentos novos.`
      : `Centro de custo "${after.code} — ${after.name}" atualizado.`
  );
}

export async function deactivateCostCenterAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Centro de custo inválido.");

  let result;
  try {
    // Excluir = DESATIVAR (não há hard delete de dado referenciado).
    result = await setCostCenterActive(container, companyId, id, false);
    if (!result.unchanged) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "cost_center.deactivated",
        entityType: "cost_center",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(
    result.unchanged
      ? `Centro de custo "${result.after.code}" já estava inativo.`
      : `Centro de custo "${result.after.code}" desativado — não aparece mais em novos lançamentos.`
  );
}

export async function reactivateCostCenterAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Centro de custo inválido.");

  let result;
  try {
    result = await setCostCenterActive(container, companyId, id, true);
    if (!result.unchanged) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "cost_center.reactivated",
        entityType: "cost_center",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(
    result.unchanged
      ? `Centro de custo "${result.after.code}" já estava ativo.`
      : `Centro de custo "${result.after.code}" reativado.`
  );
}
