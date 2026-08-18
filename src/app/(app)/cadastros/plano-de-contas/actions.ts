"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import type { ChartAccount, ChartAccountType } from "@/core/entities";
import { errorMessage, fdOptional, fdString } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cadastros/plano-de-contas";
const TYPES: ChartAccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createChartAccountAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const container = await getContainer();
  const companyId = session.company.id;

  if (!hasPermission(session.membership.role, "master_data.manage")) {
    fail("Sem permissão para gerenciar cadastros (master_data.manage).");
  }
  const code = fdString(formData, "code");
  const name = fdString(formData, "name");
  const type = fdString(formData, "type") as ChartAccountType;
  if (!code || !name) fail("Informe código e nome da conta contábil.");
  if (!TYPES.includes(type)) fail("Tipo de conta contábil inválido.");

  let existing: ChartAccount | undefined;
  try {
    existing = (await container.repos.chartAccounts.listAll(companyId)).find(
      (c) => c.code.toLowerCase() === code.toLowerCase()
    );
  } catch (error) {
    fail(errorMessage(error));
  }
  if (existing) {
    ok(`Conta contábil "${existing.code}" já estava cadastrada — nenhum registro duplicado.`);
  }

  try {
    const account: ChartAccount = {
      id: container.ids.next("coa"),
      companyId,
      code,
      name,
      type,
      parentCode: fdOptional(formData, "parentCode"),
      active: true,
    };
    await container.repos.chartAccounts.create(account);
    await container.audit.record(companyId, {
      actor: session.actor,
      action: "chart_account.created",
      entityType: "chart_account",
      entityId: account.id,
      after: account,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  ok(`Conta contábil "${code} — ${name}" cadastrada.`);
}
