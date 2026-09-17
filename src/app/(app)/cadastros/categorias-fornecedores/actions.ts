"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";
import { addSupplierCategory } from "./_lib/create";
import { reactivateSupplierCategory, removeSupplierCategory } from "./_lib/delete";
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
    const result = await renameSupplierCategory(container, companyId, id, name, session.actor);
    if (result.semMudanca) {
      mensagem = `Categoria "${result.after.name}" já tinha esse nome.`;
    } else {
      // A trilha (com `before` e os ids afetados pela cascata) é gravada DENTRO
      // da transação, em renameSupplierCategory — aqui só a mensagem.
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

/**
 * Excluir: sem vínculos (fornecedores, recorrências, títulos a pagar) apaga a
 * categoria; com vínculos DESATIVA — ela some das listas de seleção e os
 * registros existentes ficam como estão (mesma regra dos centros de custo).
 */
export async function deleteSupplierCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Categoria não informada.");

  let mensagem;
  try {
    const nowIso = container.clock.now().toISOString();
    const result = await removeSupplierCategory(container, companyId, id, nowIso);
    if (result.mode === "deleted") {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "supplier_category.deleted",
        entityType: "supplier_category",
        entityId: result.before.id,
        before: result.before,
      });
      mensagem = `Categoria "${result.before.name}" excluída.`;
    } else if (result.unchanged) {
      mensagem = `Categoria "${result.after.name}" já estava inativa.`;
    } else {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "supplier_category.deactivated",
        entityType: "supplier_category",
        entityId: result.after.id,
        before: result.before,
        after: { ...result.after, links: result.links },
      });
      mensagem =
        `Categoria "${result.after.name}" está em uso por ${result.links.total} registro(s) e foi ` +
        `desativada — não aparece mais em novos lançamentos; os registros existentes permanecem.`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  // ok() chama redirect(), que lança NEXT_REDIRECT — precisa ficar FORA do try,
  // senão o catch acima o captura e o exibe como erro na tela.
  ok(mensagem);
}

export async function reactivateSupplierCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Categoria não informada.");

  let mensagem;
  try {
    const nowIso = container.clock.now().toISOString();
    const result = await reactivateSupplierCategory(container, companyId, id, nowIso);
    if (!result.unchanged) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "supplier_category.reactivated",
        entityType: "supplier_category",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });
    }
    mensagem = result.unchanged
      ? `Categoria "${result.after.name}" já estava ativa.`
      : `Categoria "${result.after.name}" reativada.`;
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(mensagem);
}
