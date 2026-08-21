"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { CostClassification, Supplier } from "@/core/entities";
import {
  errorMessage,
  fdOptional,
  fdString,
  toTitleCase,
  toUpperName,
} from "@/app/(app)/cadastros/_lib/form-utils";
import { parseSuppliersCsv } from "./_lib/csv";
import { deleteSupplierByName } from "./_lib/delete";
import { updateSupplierFields } from "./_lib/update";

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
  const rawName = fdString(formData, "name");
  if (!rawName) fail("Informe o nome do fornecedor.");
  const name = toUpperName(rawName); // FORNECEDOR sempre em MAIÚSCULAS

  const document = fdOptional(formData, "document"); // CNPJ/CPF opcional

  const costRaw = fdOptional(formData, "costClassification");
  const costClassification: CostClassification | undefined =
    costRaw === "fixed" || costRaw === "variable" ? costRaw : undefined;
  const categoryRaw = fdOptional(formData, "category");
  const category = categoryRaw ? toTitleCase(categoryRaw) : undefined;

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
      document,
      email: fdOptional(formData, "email"),
      phone: fdOptional(formData, "phone"),
      costClassification,
      category,
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

const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 MB

/** Importa fornecedores de um arquivo CSV (cria em lote, pulando duplicados por nome). */
export async function importSuppliersAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }

  const file = formData.get("arquivo");
  if (!(file instanceof File) || file.size === 0) {
    fail("Selecione um arquivo CSV para importar.");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    fail("Arquivo excede o limite de 2 MB.");
  }

  let parsed;
  try {
    const text = await file.text();
    parsed = parseSuppliersCsv(text);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (parsed.entries.length === 0) {
    const detail = parsed.errors.length > 0 ? ` (${parsed.errors[0]})` : "";
    fail(`Nenhum fornecedor válido no CSV${detail}.`);
  }

  let criados = 0;
  let pulados = 0;
  try {
    const existentes = new Set(
      (await container.repos.suppliers.listAll(companyId)).map((s) => s.name.trim().toLowerCase())
    );
    for (const e of parsed.entries) {
      if (existentes.has(e.name.toLowerCase())) {
        pulados += 1;
        continue;
      }
      const now = container.clock.now().toISOString();
      const supplier: Supplier = {
        id: container.ids.next("sup"),
        companyId,
        name: e.name,
        document: e.document,
        email: e.email,
        phone: e.phone,
        costClassification: e.costClassification,
        category: e.category,
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
      existentes.add(e.name.toLowerCase());
      criados += 1;
    }
  } catch (error) {
    fail(errorMessage(error));
  }

  const errStr = parsed.errors.length > 0 ? ` ${parsed.errors.length} linha(s) ignorada(s).` : "";
  ok(`Importação concluída: ${criados} criado(s), ${pulados} já existia(m).${errStr}`);
}

/** Atualiza os dados de um fornecedor existente (botão Editar da lista). */
export async function updateSupplierAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const id = fdString(formData, "id");
  if (!id) fail("Fornecedor inválido para edição.");
  const rawName = fdString(formData, "name");
  if (!rawName) fail("Informe o nome do fornecedor.");

  const costRaw = fdOptional(formData, "costClassification");
  const costClassification: CostClassification | undefined =
    costRaw === "fixed" || costRaw === "variable" ? costRaw : undefined;

  try {
    const updated = await updateSupplierFields(container, companyId, id, {
      name: rawName,
      document: fdOptional(formData, "document"),
      email: fdOptional(formData, "email"),
      phone: fdOptional(formData, "phone"),
      costClassification,
      category: fdOptional(formData, "category"),
    });
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "supplier.updated",
      entityType: "supplier",
      entityId: updated.id,
      after: updated,
    });
    ok(`Fornecedor "${updated.name}" atualizado.`);
  } catch (error) {
    fail(errorMessage(error));
  }
}

/** Exclui o fornecedor selecionado no campo FORNECEDOR (só se não tiver títulos). */
export async function deleteSupplierAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const name = fdString(formData, "name");
  if (!name) fail("Selecione um fornecedor no campo FORNECEDOR para excluir.");

  try {
    const deleted = await deleteSupplierByName(container, companyId, name);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "supplier.deleted",
      entityType: "supplier",
      entityId: name,
      before: { name: deleted },
    });
    ok(`Fornecedor "${deleted}" excluído.`);
  } catch (error) {
    fail(errorMessage(error));
  }
}
