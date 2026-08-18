"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatBRL } from "@/lib/format";
import type { Invoice } from "@/core/entities";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import {
  errorMessage,
  fdOptional,
  fdString,
  flowErrorMessage,
  parseBRLToCents,
  parseInstallmentsSpec,
  type InstallmentSpec,
} from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/faturamento";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function createInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { orchestrator } = await getContainer();

  const customerId = fdString(formData, "customerId");
  const description = fdString(formData, "description");
  if (!customerId || !description) fail("Preencha cliente e descrição.");
  const issue = formData.get("issue") === "on";

  let totalCents = 0;
  let installments: InstallmentSpec[] = [];
  try {
    totalCents = parseBRLToCents(fdString(formData, "total"));
    installments = parseInstallmentsSpec(fdString(formData, "installments"));
  } catch (error) {
    fail(errorMessage(error));
  }
  if (totalCents <= 0) fail("O total da fatura deve ser positivo.");
  if (installments.length > 0) {
    const sum = installments.reduce((acc, i) => acc + i.amountCents, 0);
    if (sum !== totalCents) {
      fail(
        `A soma das parcelas (${formatBRL(sum)}) difere do total da fatura (${formatBRL(totalCents)}).`
      );
    }
  }

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "customer_invoice_intake",
      companyId: session.company.id,
      actor: session.actor,
      payload: {
        customerId,
        description,
        totalCents,
        saleRef: fdOptional(formData, "saleRef"),
        // O passo invoice_create do fluxo usa "issue: true, ...payload":
        // o valor abaixo prevalece e controla a emissão imediata.
        issue,
        installments: installments.length > 0 ? installments : undefined,
      },
    });
  } catch (error) {
    fail(errorMessage(error));
  }

  const created = response.results.find((r) => r.stepId === "invoice_create")?.result;
  const invoice = (created?.data as { invoice?: Invoice } | null)?.invoice;
  if (!invoice) fail(flowErrorMessage(response));

  if (!issue) {
    // Sem emissão, o passo de títulos a receber não prossegue — comportamento esperado.
    ok(
      `Fatura ${invoice.id} criada como rascunho (${formatBRL(totalCents)}). Títulos a receber serão gerados na emissão.`
    );
  }
  if (response.status === "failed") fail(flowErrorMessage(response));
  ok(
    `Fatura emitida (NF-e mock ${invoice.nfeMock?.number ?? "—"}) no total de ${formatBRL(totalCents)}; títulos a receber gerados.`
  );
}
