import { NextResponse } from "next/server";
import { withAuth, queryOf } from "@/app/api/_lib/http";
import { hasPermission } from "@/core/auth";
import { PermissionError, ValidationError } from "@/core/errors";
import { ACTION_LABELS, formatDateTime } from "@/lib/format";
import { toCsv, buildPdfReport } from "@/lib/exporters";

export const runtime = "nodejs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXPORT_LIMIT = 10_000;

/** Rótulo da ação em pt-BR + o código técnico entre parênteses (fallback: código). */
function actionText(action: string): string {
  const label = ACTION_LABELS[action];
  return label ? `${label} (${action})` : action;
}

/**
 * GET /api/v1/audit/export?format=csv|pdf&<filtros da tela /auditoria>
 * Exporta a trilha de auditoria (exige audit.view), respeitando os filtros
 * ativos (não a paginação), com teto de 10.000 registros. Escopo sempre pelo
 * companyId da sessão — nunca de query param. Registra a exportação na trilha
 * (report.generated).
 */
export const GET = withAuth(async (req, { session, container }) => {
  if (!hasPermission(session.membership.role, "audit.view")) {
    throw new PermissionError(
      `Papel ${session.membership.role} não possui a permissão audit.view.`
    );
  }

  const q = queryOf(req);
  const format = q.format === "pdf" ? "pdf" : "csv";
  const companyId = session.company.id; // escopo obrigatório — nunca de query

  // Mesmos filtros da tela /auditoria.
  const entityType = q.entityType?.trim() || undefined;
  const entityId = q.entityId?.trim() || undefined;
  const actorId = q.ator?.trim() || undefined;
  const action = q.acao?.trim() || undefined;
  const de = q.de && ISO_DATE_RE.test(q.de) ? q.de : undefined;
  const ate = q.ate && ISO_DATE_RE.test(q.ate) ? q.ate : undefined;
  const invalidRange = Boolean(de && ate && de > ate);
  const from = invalidRange ? undefined : de;
  const to = invalidRange ? undefined : ate;

  const { repos, audit } = container;

  // Respeita os filtros, NÃO a paginação: limit alto + teto de segurança.
  const page = await repos.audit.listPage(companyId, {
    offset: 0,
    limit: EXPORT_LIMIT + 1,
    entityType,
    entityId,
    actorId,
    action,
    from,
    to,
  });
  if (page.total > EXPORT_LIMIT) {
    throw new ValidationError(
      `A exportação está limitada a ${EXPORT_LIMIT.toLocaleString("pt-BR")} registros e o filtro atual retorna ${page.total.toLocaleString("pt-BR")}. Estreite o período (De/Até) e tente novamente.`
    );
  }
  const rows = page.items; // já vem ordenado por seq desc

  // Nomes dos atores: uma consulta + Map (sem getById em loop).
  const users = await repos.users.listAll();
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const actorName = (r: (typeof rows)[number]): string =>
    r.actorType === "user" ? (userName.get(r.actorId) ?? r.actorId) : `${r.actorType}:${r.actorId}`;

  // Descrição dos filtros aplicados (para o cabeçalho do PDF e o registro).
  const filterParts: string[] = [];
  if (from || to) filterParts.push(`período ${from ?? "…"} a ${to ?? "…"}`);
  if (actorId) filterParts.push(`ator ${userName.get(actorId) ?? actorId}`);
  if (action) filterParts.push(`ação ${action}`);
  if (entityType) filterParts.push(`entidade ${entityType}`);
  if (entityId) filterParts.push(`id ${entityId}`);
  const filtersLabel = filterParts.length > 0 ? filterParts.join("; ") : "sem filtros";

  const stamp = formatDateTime(new Date().toISOString());
  const filenameBase = `auditoria-${session.company.id}`;

  let body: BodyInit;
  let contentType: string;
  let filename: string;

  if (format === "csv") {
    // before/after como JSON (formato que um auditor consegue processar).
    const csvRows = rows.map((r) => ({
      seq: r.seq,
      quando: formatDateTime(r.timestamp),
      ator: actorName(r),
      acao: actionText(r.action),
      tipo_entidade: r.entityType,
      id_entidade: r.entityId,
      antes: r.before === undefined ? "" : JSON.stringify(r.before),
      depois: r.after === undefined ? "" : JSON.stringify(r.after),
    }));
    body = toCsv(csvRows, [
      { key: "quando", label: "Data/hora" },
      { key: "ator", label: "Ator" },
      { key: "acao", label: "Ação" },
      { key: "tipo_entidade", label: "Tipo de entidade" },
      { key: "id_entidade", label: "ID da entidade" },
      { key: "seq", label: "Seq" },
      { key: "antes", label: "Antes (JSON)" },
      { key: "depois", label: "Depois (JSON)" },
    ]);
    contentType = "text/csv; charset=utf-8";
    filename = `${filenameBase}.csv`;
  } else {
    // PDF: SEM before/after (destrói a diagramação). Cabeçalho com empresa,
    // data/hora da geração e filtros aplicados.
    const pdfBytes = await buildPdfReport({
      title: "Trilha de auditoria",
      subtitle: `${session.company.name} · gerado em ${stamp} · ${rows.length} registro(s) · filtros: ${filtersLabel}`,
      sections: [
        {
          heading: "Registros",
          table: {
            headers: ["Data/hora", "Ator", "Ação", "Tipo", "ID", "Seq"],
            rows: rows.map((r) => [
              formatDateTime(r.timestamp),
              actorName(r),
              actionText(r.action),
              r.entityType,
              r.entityId,
              String(r.seq),
            ]),
          },
        },
      ],
    });
    body = Buffer.from(pdfBytes); // Buffer é BodyInit válido (Uint8Array cru não tipa)
    contentType = "application/pdf";
    filename = `${filenameBase}.pdf`;
  }

  // Deixa rastro da própria exportação (leitura em massa de dado sensível).
  await audit.record(companyId, {
    actor: session.actor,
    action: "report.generated",
    entityType: "audit_export",
    entityId: `${format}:${rows.length}`,
    after: { format, registros: rows.length, filtros: filtersLabel },
  });

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  };
  return new NextResponse(body, { headers });
});
