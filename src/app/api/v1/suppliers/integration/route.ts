import { listSuppliersForIntegration } from "@/app/api/_lib/handlers";
import { withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * GET /api/v1/suppliers/integration — fornecedores (id, nome, CNPJ, categoria e classificação), somente leitura, para integrações acharem o
 * supplierId antes de criar um título. Papel viewer basta; nunca devolve banco, PIX, e-mail nem telefone.
 */
export const GET = withAuth(async (_req, { session, container }) => json(await listSuppliersForIntegration(container, session)));
