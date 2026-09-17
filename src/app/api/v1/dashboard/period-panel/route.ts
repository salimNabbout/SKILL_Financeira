import { getPeriodPanel } from "@/app/api/_lib/dashboard";
import { queryOf, withAuth } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";

export const runtime = "nodejs";

/**
 * GET /api/v1/dashboard/period-panel?ano=2026&mes=8|todos&de=1&ate=31&cc=<id>&cat=<nome>
 * Painel por Período (regime de caixa): totais recebido/pago/fixo/variável do
 * período, gasto por centro de custo e por categoria. Mesma autenticação do
 * dashboard (qualquer sessão da empresa). Envelope SkillResult.
 */
export const GET = withAuth(async (req, { session, container }) =>
  json(await getPeriodPanel(container, session, queryOf(req)))
);
