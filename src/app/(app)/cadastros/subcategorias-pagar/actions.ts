"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";
import { addPayableSubcategory } from "./_lib/create";
import { reactivatePayableSubcategory, removePayableSubcategory } from "./_lib/delete";
import { renamePayableSubcategory } from "./_lib/update";

const PATH = "/cadastros/subcategorias-pagar";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createPayableSubcategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome da subcategoria.");

  let mensagem;
  try {
    const { subcategory, created } = await addPayableSubcategory(container, companyId, name);
    if (created) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "payable_subcategory.created",
        entityType: "payable_subcategory",
        entityId: subcategory.id,
        after: subcategory,
      });
      mensagem = `Subcategoria "${subcategory.name}" cadastrada.`;
    } else {
      mensagem = `Subcategoria "${subcategory.name}" já estava cadastrada.`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  // ok() chama redirect(), que lança NEXT_REDIRECT — precisa ficar FORA do try,
  // senão o catch acima o captura e o exibe como erro na tela.
  ok(mensagem);
}

export async function updatePayableSubcategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Subcategoria não informada.");
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome da subcategoria.");

  let mensagem;
  try {
    const result = await renamePayableSubcategory(container, companyId, id, name);
    if (result.semMudanca) {
      mensagem = `Subcategoria "${result.after.name}" já tinha esse nome.`;
    } else {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "payable_subcategory.updated",
        entityType: "payable_subcategory",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });
      mensagem = `Subcategoria renomeada para "${result.after.name}". Títulos já lançados mantêm o nome anterior.`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(mensagem);
}

/**
 * Excluir: sem títulos a pagar usando o nome, apaga a subcategoria; com títulos
 * DESATIVA — ela some da caixa de seleção e os títulos existentes ficam como estão.
 */
export async function deletePayableSubcategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Subcategoria não informada.");

  let mensagem;
  try {
    const nowIso = container.clock.now().toISOString();
    const result = await removePayableSubcategory(container, companyId, id, nowIso);
    if (result.mode === "deleted") {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "payable_subcategory.deleted",
        entityType: "payable_subcategory",
        entityId: result.before.id,
        before: result.before,
      });
      mensagem = `Subcategoria "${result.before.name}" excluída.`;
    } else if (result.unchanged) {
      mensagem = `Subcategoria "${result.after.name}" já estava inativa.`;
    } else {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "payable_subcategory.deactivated",
        entityType: "payable_subcategory",
        entityId: result.after.id,
        before: result.before,
        after: { ...result.after, links: result.links },
      });
      mensagem =
        `Subcategoria "${result.after.name}" está em uso por ${result.links.total} título(s) e foi ` +
        `desativada — não aparece mais em novos lançamentos; os títulos existentes permanecem.`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(mensagem);
}

export async function reactivatePayableSubcategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Subcategoria não informada.");

  let mensagem;
  try {
    const nowIso = container.clock.now().toISOString();
    const result = await reactivatePayableSubcategory(container, companyId, id, nowIso);
    if (!result.unchanged) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "payable_subcategory.reactivated",
        entityType: "payable_subcategory",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });
    }
    mensagem = result.unchanged
      ? `Subcategoria "${result.after.name}" já estava ativa.`
      : `Subcategoria "${result.after.name}" reativada.`;
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(mensagem);
}
