import { withAuth } from "@/app/api/_lib/http";
import { queryOf } from "@/app/api/_lib/http";
import { json } from "@/app/api/_lib/respond";
import { runReport } from "@/app/api/_lib/reports";

export const runtime = "nodejs";

/**
 * GET /api/v1/reports/:report?format=json|csv|pdf&period=YYYY-MM
 * report ∈ daily_summary | monthly_close | executive_overview (monthly_close exige period).
 * json → envelope SkillResult; csv/pdf → download (Content-Disposition: attachment).
 */
export const GET = withAuth<{ report: string }>(async (req, { session, container, params }) => {
  const out = await runReport(container, session, params.report, queryOf(req));
  if (out.kind === "json") return json(out.result);
  if (out.kind === "csv") {
    return new Response(out.content, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
      },
    });
  }
  return new Response(new Uint8Array(out.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
    },
  });
});
