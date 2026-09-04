"use server";

import { redirect } from "next/navigation";
import { HashChainAuditTrail } from "@/core/audit";
import { getContainer } from "@/lib/container";
import { requireSession, setSessionCookie } from "@/lib/session";

/**
 * Troca a empresa ativa da sessão. Só permite empresas em que o usuário tem
 * vínculo (RBAC); a troca é auditada na empresa de destino.
 */
export async function switchCompanyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const companyId = String(formData.get("companyId") ?? "");
  if (!companyId || companyId === session.company.id) redirect("/");

  const { repos, clock, ids } = await getContainer();
  const membership = await repos.memberships.findByUserAndCompany(session.user.id, companyId);
  const company = membership ? await repos.companies.getById(companyId) : null;
  if (!membership || !company || !company.active) redirect("/");

  const audit = new HashChainAuditTrail(repos.audit, clock, ids);
  await audit.record(companyId, {
    actor: { type: "user", id: session.user.id, role: membership.role },
    action: "auth.switch_company",
    entityType: "company",
    entityId: companyId,
    after: { from: session.company.id },
  });

  await setSessionCookie(session.user.id, companyId);
  redirect("/");
}
