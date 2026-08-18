import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { formatDateTime } from "@/lib/format";
import { verifyChain } from "@/core/audit";

const MAX_ROWS = 200;

function smallJson(value: unknown): string {
  const json = JSON.stringify(value, null, 1) ?? "null";
  return json.length > 2000 ? `${json.slice(0, 2000)}\n… (truncado)` : json;
}

export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<{ entityType?: string; entityId?: string }>;
}) {
  const params = await searchParams;
  const entityType = params.entityType?.trim() || undefined;
  const entityId = params.entityId?.trim() || undefined;
  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  // Integridade: a cadeia é verificada sobre TODOS os registros da empresa
  // (o filtro vale apenas para a tabela — filtrar quebraria o encadeamento).
  const allRecords = await repos.audit.list(companyId);
  const chain = verifyChain(allRecords);

  const filtered =
    entityType || entityId ? await repos.audit.list(companyId, { entityType, entityId }) : allRecords;
  const rows = [...filtered].sort((a, b) => b.seq - a.seq).slice(0, MAX_ROWS);

  const users = await repos.users.listAll();
  const userName = new Map(users.map((u) => [u.id, u.name]));

  return (
    <div>
      <PageHeader
        title="Auditoria"
        subtitle="Trilha imutável de tudo que aconteceu — cada registro encadeia o hash do anterior (adulteração é detectável)."
      />

      <div className="mb-6">
        {chain.valid ? (
          <div className="card border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-[var(--ok)]">
              Cadeia íntegra ✓ ({allRecords.length} registro{allRecords.length === 1 ? "" : "s"})
            </p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              hash = sha256(hash_anterior + conteúdo canônico) verificado registro a registro.
            </p>
          </div>
        ) : (
          <div className="card border-red-300 bg-red-50 p-4">
            <p className="text-sm font-semibold text-[var(--crit)]">
              Cadeia de auditoria QUEBRADA no registro seq {chain.brokenAtSeq} — possível adulteração.
            </p>
            <p className="mt-1 text-xs text-[var(--crit)]">
              Trate como incidente: os registros a partir desse ponto não são confiáveis.
            </p>
          </div>
        )}
      </div>

      <Card className="mb-6" title="Filtros">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Tipo de entidade">
            <input
              name="entityType"
              defaultValue={entityType ?? ""}
              className={`${inputClass} w-56`}
              placeholder="Ex.: payable, Approval, FlowRun"
            />
          </Field>
          <Field label="ID da entidade">
            <input
              name="entityId"
              defaultValue={entityId ?? ""}
              className={`${inputClass} w-56`}
              placeholder="Ex.: pay_123"
            />
          </Field>
          <Button variant="secondary">Filtrar</Button>
          {entityType || entityId ? (
            <Link href="/auditoria" className="text-sm text-[var(--brand)] underline">
              Limpar filtros
            </Link>
          ) : null}
        </form>
      </Card>

      <Card title={`Registros (${rows.length}${filtered.length > MAX_ROWS ? ` de ${filtered.length} — exibindo os mais recentes` : ""})`}>
        {rows.length === 0 ? (
          <EmptyState message="Nenhum registro de auditoria para o filtro informado." />
        ) : (
          <Table
            headers={["Seq", "Quando", "Ator", "Ação", "Entidade", "Antes/Depois"]}
            align={["r", "l", "l", "l", "l", "l"]}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td right>
                  <span className="tabular">{r.seq}</span>
                </Td>
                <Td>{formatDateTime(r.timestamp)}</Td>
                <Td>
                  {r.actorType === "user" ? (
                    (userName.get(r.actorId) ?? r.actorId)
                  ) : (
                    <span>
                      <Badge tone="neutral">{r.actorType === "skill" ? "skill" : "sistema"}</Badge>{" "}
                      <span className="text-xs">{r.actorId}</span>
                    </span>
                  )}
                </Td>
                <Td>
                  <span className="tabular text-xs">{r.action}</span>
                </Td>
                <Td>
                  <span className="text-xs">
                    {r.entityType} <span className="text-[var(--ink-muted)]">{r.entityId}</span>
                  </span>
                </Td>
                <Td>
                  {r.before !== undefined || r.after !== undefined ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-[var(--brand)]">detalhes</summary>
                      <div className="mt-1 max-w-md space-y-2">
                        {r.before !== undefined ? (
                          <div>
                            <p className="text-[11px] font-semibold uppercase text-[var(--ink-muted)]">antes</p>
                            <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[11px]">
                              {smallJson(r.before)}
                            </pre>
                          </div>
                        ) : null}
                        {r.after !== undefined ? (
                          <div>
                            <p className="text-[11px] font-semibold uppercase text-[var(--ink-muted)]">depois</p>
                            <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[11px]">
                              {smallJson(r.after)}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ) : (
                    <span className="text-xs text-[var(--ink-muted)]">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
