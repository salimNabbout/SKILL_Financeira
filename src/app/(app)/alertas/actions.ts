"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import type { Alert } from "@/core/entities";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/alertas";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

export async function acknowledgeAlertAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  const alertId = fdString(formData, "alertId");
  if (!alertId) fail("Alerta inválido.");

  let alert: Alert | null = null;
  try {
    alert = await container.repos.alerts.getById(companyId, alertId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!alert) fail("Alerta não encontrado.");

  if (alert.status === "open") {
    try {
      const before = { status: alert.status };
      const updated: Alert = { ...alert, status: "acknowledged" };
      await container.repos.alerts.update(updated);
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "alert.acknowledged",
        entityType: "alert",
        entityId: alert.id,
        before,
        after: { status: updated.status },
      });
    } catch (error) {
      fail(errorMessage(error));
    }
  }
  // Já reconhecido/resolvido: nada a fazer (ação idempotente).

  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent("Alerta reconhecido.")}`);
}
