"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";
import { addSupplierCategory } from "./_lib/create";
import { renameSupplierCategory } from "./_lib/update";

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

  let mensagem;
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
      mensagem = `Categoria "${category.name}" cadastrada.`;
    } else {
      mensagem = `Categoria "${category.name}" já estava cadastrada.`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  // ok() chama redirect(), que lança NEXT_REDIRECT — precisa ficar FORA do try,
  // senão o catch acima o captura e o exibe como erro na tela.
  ok(mensagem);
}

export async function updateSupplierCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Categoria não informada.");
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome da categoria.");

  let mensagem;
  try {
    const result = await renameSupplierCategory(container, companyId, id, name);
    if (result.semMudanca) {
      mensagem = `Categoria "${result.after.name}" já tinha esse nome.`;
    } else {
      // O create registra apenas `after`; aqui o `before` é essencial — sem ele
      // a trilha não mostra de que nome a categoria veio.
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "supplier_category.updated",
        entityType: "supplier_category",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });

      const propagados = result.suppliersAtualizados + result.recorrenciasAtualizadas;
      mensagem =
        propagados === 0
          ? `Categoria renomeada para "${result.after.name}".`
          : `Categoria renomeada para "${result.after.name}" (${propagados} cadastro(s) atualizado(s)).`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  // ok() chama redirect(), que lança NEXT_REDIRECT — precisa ficar FORA do try,
  // senão o catch acima o captura e o exibe como erro na tela.
  ok(mensagem);
}
