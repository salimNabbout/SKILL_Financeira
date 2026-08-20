"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";
import { addSupplierCategory } from "./_lib/create";

const PATH = "/cadastros/categorias-fornecedores";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createSupplierCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome da categoria.");

  try {
    const { category, created } = await addSupplierCategory(container, companyId, name);
    if (created) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "supplier_category.created",
        entityType: "supplier_category",
        entityId: category.id,
        after: category,
      });
      ok(`Categoria "${category.name}" cadastrada.`);
    }
    ok(`Categoria "${category.name}" já estava cadastrada.`);
  } catch (error) {
    fail(errorMessage(error));
  }
}
