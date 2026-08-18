"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { CostCenter } from "@/core/entities";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/centros-de-custo";

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
