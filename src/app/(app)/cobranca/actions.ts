"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import type { CollectionMessage } from "@/core/entities";
import type { OrchestratorResponse } from "@/core/orchestrator/orchestrator";
import { errorMessage, flowErrorMessage } from "@/app/(app)/cadastros/_lib/form-utils";

const PATH = "/cobranca";

function fail(message: string): never {
  redirect(`${PATH}?erro=${encodeURIComponent(message)}`);
}

function ok(message: string): never {
  revalidatePath(PATH);
  redirect(`${PATH}?ok=${encodeURIComponent(message)}`);
}

export async function runDunningAction(): Promise<void> {
  const session = await requireSession();
  const { orchestrator, ids } = await getContainer();

  let response: OrchestratorResponse;
  try {
    response = await orchestrator.execute({
      flow: "dunning_run",
      companyId: session.company.id,
      actor: session.actor,
      payload: {},
      // A régua é reexecutável por natureza (a idempotência por título+step é
      // da própria skill); chave única por clique evita replay do cache do
      // orquestrador em execuções futuras legítimas.
      idempotencyKey: ids.next("dunrun"),
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  if (response.status === "failed") fail(flowErrorMessage(response));

  const dunning = response.results.find((r) => r.stepId === "dunning")?.result?.data as
    | { messages?: CollectionMessage[]; sent?: number }
    | null
    | undefined;
  const drafted = dunning?.messages?.length ?? 0;

  if (response.status === "awaiting_approval") {
    ok(
      `Régua executada: ${drafted} mensagem(ns) de cobrança aguardando aprovação humana — decida em Aprovações.`
    );
  }
  ok(
    `Régua executada: ${drafted} nova(s) mensagem(ns), ${dunning?.sent ?? 0} enviada(s) (envio mock). ${response.consolidated.summary}`
  );
}
