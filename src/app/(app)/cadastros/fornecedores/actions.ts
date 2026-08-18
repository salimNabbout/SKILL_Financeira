"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { Supplier } from "@/core/entities";
import { errorMessage, fdOptional, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/fornecedores";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createSupplierAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome do fornecedor.");

  let existing: Supplier | undefined;
  try {
    existing = (await container.repos.suppliers.listAll(companyId)).find(
      (s) => s.name.trim().toLowerCase() === name.toLowerCase()
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  if (existing) {
    ok(`Fornecedor "${existing.name}" já estava cadastrado — nenhum registro duplicado.`);
  }

  try {
    const now = container.clock.now().toISOString();
    const supplier: Supplier = {
      id: container.ids.next("sup"),
      companyId,
      name,
      document: fdOptional(formData, "document"),
      email: fdOptional(formData, "email"),
      phone: fdOptional(formData, "phone"),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await container.repos.suppliers.create(supplier);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "supplier.created",
      entityType: "supplier",
      entityId: supplier.id,
      after: supplier,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Fornecedor "${name}" cadastrado.`);
}
