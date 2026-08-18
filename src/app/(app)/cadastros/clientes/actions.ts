"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { Customer } from "@/core/entities";
import { errorMessage, fdOptional, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/clientes";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createCustomerAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome do cliente.");

  // Idempotência por chave natural (nome, case-insensitive): não duplica.
  let existing: Customer | undefined;
  try {
    existing = (await container.repos.customers.listAll(companyId)).find(
      (c) => c.name.trim().toLowerCase() === name.toLowerCase()
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  if (existing) {
    ok(`Cliente "${existing.name}" já estava cadastrado — nenhum registro duplicado.`);
  }

  try {
    const now = container.clock.now().toISOString();
    const customer: Customer = {
      id: container.ids.next("cus"),
      companyId,
      name,
      document: fdOptional(formData, "document"),
      email: fdOptional(formData, "email"),
      phone: fdOptional(formData, "phone"),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await container.repos.customers.create(customer);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "customer.created",
      entityType: "customer",
      entityId: customer.id,
      after: customer,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Cliente "${name}" cadastrado.`);
}
