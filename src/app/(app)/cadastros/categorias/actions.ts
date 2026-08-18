"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { Category, CategoryKind, DreGroup } from "@/core/entities";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/categorias";
const KINDS: CategoryKind[] = ["income", "expense"];
const DRE_GROUPS: DreGroup[] = [
  "receita_bruta",
  "deducoes",
  "custos",
  "despesas_operacionais",
  "despesas_financeiras",
  "receitas_financeiras",
  "outras",
];

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const name = fdString(formData, "name");
  const kind = fdString(formData, "kind") as CategoryKind;
  const dreGroup = fdString(formData, "dreGroup") as DreGroup;
  if (!name) fail("Informe o nome da categoria.");
  if (!KINDS.includes(kind)) fail("Tipo de categoria inválido.");
  if (!DRE_GROUPS.includes(dreGroup)) fail("Grupo de DRE inválido.");

  let existing: Category | undefined;
  try {
    existing = (await container.repos.categories.listAll(companyId)).find(
      (c) => c.kind === kind && c.name.trim().toLowerCase() === name.toLowerCase()
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  if (existing) {
    ok(`Categoria "${existing.name}" já estava cadastrada — nenhum registro duplicado.`);
  }

  try {
    const category: Category = {
      id: container.ids.next("cat"),
      companyId,
      name,
      kind,
      dreGroup,
      active: true,
    };
    await container.repos.categories.create(category);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "category.created",
      entityType: "category",
      entityId: category.id,
      after: category,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Categoria "${name}" cadastrada.`);
}
