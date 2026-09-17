"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { RoleName } from "@/core/entities";
import { errorMessage, fdString } from "@/app/(app)/cadastros/_lib/form-utils";
import { addReceivableCategory } from "./_lib/create";
import { reactivateReceivableCategory, removeReceivableCategory } from "./_lib/delete";
import { renameReceivableCategory } from "./_lib/update";

const PATH = "/cadastros/categorias-receber";
// A tela de Contas a receber lê as mesmas categorias no select "Categoria (opcional)".
const CONTAS_A_RECEBER = "/contas-a-receber";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  revalidatePath(CONTAS_A_RECEBER);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

function requireManage(role: RoleName): void {
  if (!hasPermission(role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
}

export async function createReceivableCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;
  requireManage(session.membership.role);
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome da categoria.");

  let mensagem;
  try {
    const { category, created } = await addReceivableCategory(container, companyId, name);
    if (created) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "category.created",
        entityType: "category",
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

export async function updateReceivableCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;
  requireManage(session.membership.role);
  const id = fdString(formData, "id");
  if (!id) fail("Categoria não informada.");
  const name = fdString(formData, "name");
  if (!name) fail("Informe o nome da categoria.");

  let mensagem;
  try {
    const result = await renameReceivableCategory(container, companyId, id, name);
    if (result.semMudanca) {
      mensagem = `Categoria "${result.after.name}" já tinha esse nome.`;
    } else {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "category.updated",
        entityType: "category",
        entityId: result.after.id,
        before: result.before,
        after: result.after,
      });
      mensagem = `Categoria renomeada para "${result.after.name}".`;
    }
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(mensagem);
}

/**
 * Excluir: sem vínculos (títulos a receber/pagar, linhas de orçamento) apaga a
 * categoria; com vínculos DESATIVA — ela some do select de Contas a receber e
 * os registros existentes ficam como estão (mesma regra dos centros de custo).
 */
export async function deleteReceivableCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;
  requireManage(session.membership.role);
  const id = fdString(formData, "id");
  if (!id) fail("Categoria não informada.");

  let mensagem;
  try {
    const result = await removeReceivableCategory(container, companyId, id);
    if (result.mode === "deleted") {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "category.deleted",
        entityType: "category",
        entityId: result.before.id,
        before: result.before,
      });
      mensagem = `Categoria "${result.before.name}" excluída.`;
    } else if (result.unchanged) {
      mensagem = `Categoria "${result.after.name}" já estava inativa.`;
    } else {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "category.deactivated",
        entityType: "category",
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
  ok(mensagem);
}

export async function reactivateReceivableCategoryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;
  requireManage(session.membership.role);
  const id = fdString(formData, "id");
  if (!id) fail("Categoria não informada.");

  let mensagem;
  try {
    const result = await reactivateReceivableCategory(container, companyId, id);
    if (!result.unchanged) {
      await container.audit.record(companyId, {
        actor: session.actor,
        action: "category.reactivated",
        entityType: "category",
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
