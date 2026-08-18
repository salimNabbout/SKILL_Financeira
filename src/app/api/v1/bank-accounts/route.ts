import { createBankAccount, listBankAccounts } from "@/app/api/_lib/handlers";
import { readJson, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/bank-accounts — contas bancárias (número sempre mascarado). */
export const GET = withAuth(async (_req, { session, container }) =>
  json(await listBankAccounts(container, session))
);

/**
 * POST /api/v1/bank-accounts — cria conta bancária (exige bank_account.manage).
 * O número da conta é mascarado antes de persistir. 201 criado, 200 replay.
 */
export const POST = withAuth(async (req, { session, container }) => {
  const { entity, created } = await createBankAccount(container, session, await readJson(req));
  return json(entity, created ? 201 : 200);
});
