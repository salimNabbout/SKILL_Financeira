import { listBankTransactions } from "@/app/api/_lib/handlers";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/** GET /api/v1/bank-transactions?accountId=&reconciled= — transações do extrato importado. */
export const GET = withAuth(async (req, { session, container }) =>
  json(await listBankTransactions(container, session, queryOf(req)))
);
