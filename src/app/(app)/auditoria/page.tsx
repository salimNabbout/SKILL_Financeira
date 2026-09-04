import Link from "next/link";
import {
  actionFilterAliases,
  canonicalAction,
  entityFilterAliases,
} from "@/core/audit-actions";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { ACTION_LABELS, formatDateTime } from "@/lib/format";
import { verifyChain } from "@/core/audit";
import type { ActivityEvent } from "@/core/entities";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";

function smallJson(value: unknown): string {
  const json = JSON.stringify(value, null, 1) ?? "null";
  return json.length > 2000 ? `${json.slice(0, 2000)}\n… (truncado)` : json;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Rótulos em linguagem corrente dos eventos de atividade (código exato fica visível junto).
const EVENT_TYPE_LABELS: Record<string, string> = {
  clique: "Clique",
  submissao: "Envio de formulário",
  navegacao: "Navegação",
  interacao: "Interação com campo",
  requisicao: "Requisição à API",
};
const ORIGIN_LABELS: Record<string, string> = {
  frontend: "Interface",
  backend: "API",
};

/** Navegação entre as abas Trilha de negócio / Atividade (estado na URL). */
function Tabs({ active }: { active: "trilha" | "atividade" }) {
  const tabClass = (isActive: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm ${
      isActive
        ? "bg-[var(--brand)] font-semibold text-white"
        : "border border-[var(--line)] bg-white text-[var(--ink)] hover:bg-slate-50"
    }`;
  return (
    <div className="mb-6 flex gap-2">
      <Link href="/auditoria" className={tabClass(active === "trilha")}>
        Trilha de negócio
      </Link>
      <Link href="/auditoria?aba=atividade" className={tabClass(active === "atividade")}>
        Atividade
      </Link>
    </div>
  );
}

export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<{
    aba?: string;
    entityType?: string;
    entityId?: string;
    p?: string;
    ator?: string;
    acao?: string;
    de?: string;
    ate?: string;
    usuario?: string;
    tipo?: string;
    origem?: string;
    tela?: string;
    q?: string;
  }>;
}) {
  const params = await searchParams;
  const aba = params.aba === "atividade" ? "atividade" : "trilha";
  const de = params.de && ISO_DATE_RE.test(params.de) ? params.de : undefined;
  const ate = params.ate && ISO_DATE_RE.test(params.ate) ? params.ate : undefined;
  // De > Até: ignora o intervalo e avisa (não quebra).
  const invalidRange = Boolean(de && ate && de > ate);
  const from = invalidRange ? undefined : de;
  const to = invalidRange ? undefined : ate;

  const session = await requireSession();
  const { repos } = await getContainer();
  const companyId = session.company.id;

  const users = await repos.users.listAll();
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userOptions = [...users].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  // -------------------------------------------------------------------------
  // Aba ATIVIDADE: telemetria de uso (cliques, navegação, requisições).
  // Tabela separada, sem cadeia de hash — a verificação de integridade da
  // trilha não roda aqui (não se aplica e pouparia o custo à toa).
  // -------------------------------------------------------------------------
  if (aba === "atividade") {
    const userId = params.usuario?.trim() || undefined;
    const eventType = params.tipo?.trim() || undefined;
    const origin =
      params.origem === "frontend" || params.origem === "backend" ? params.origem : undefined;
    const screen = params.tela?.trim() || undefined;
    const q = params.q?.trim() || undefined;

    const page = await repos.activityEvents.listPage(companyId, {
      offset: pageOffset(params.p),
      limit: PAGE_SIZE,
      userId,
      eventType,
      origin,
      screen,
      q,
      from,
      to,
    });
    const eventTypes = await repos.activityEvents.listEventTypes(companyId);

    const anyFilterActive =
      Boolean(userId) || Boolean(eventType) || Boolean(origin) || Boolean(screen) || Boolean(q) || Boolean(from) || Boolean(to);
    const extraQuery: Record<string, string | undefined> = {
      aba: "atividade",
      usuario: userId,
      tipo: eventType,
      origem: origin,
      tela: screen,
      q,
      de: from,
      ate: to,
    };

    // "Onde" o evento aconteceu: tela (interface) ou método+rota (API).
    const whereOf = (e: ActivityEvent) =>
      e.origin === "backend" ? `${e.method ?? ""} ${e.path ?? ""}`.trim() : (e.screen ?? "—");

    // Detalhes expandíveis: tudo que não coube nas colunas, em JSON legível.
    const expandedOf = (e: ActivityEvent) => {
      const extra: Record<string, unknown> = {};
      if (e.elementId !== undefined) extra.elemento = e.elementId;
      if (e.status !== undefined) extra.status = e.status;
      if (e.durationMs !== undefined) extra.duracaoMs = e.durationMs;
      if (e.ip !== undefined) extra.ip = e.ip;
      if (e.userAgent !== undefined) extra.userAgent = e.userAgent;
      if (e.details !== undefined) extra.detalhes = e.details;
      return Object.keys(extra).length > 0 ? extra : undefined;
    };

    return (
      <div>
        <PageHeader
          title="Auditoria"
          subtitle="Atividade de uso: todo clique, navegação e requisição autenticada — quem fez o quê, onde e quando."
        />
        <Tabs active="atividade" />

        <Card className="mb-6" title="Filtros">
          <form method="get" action="/auditoria" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="aba" value="atividade" />
            <Field label="De">
              <input type="date" name="de" defaultValue={de ?? ""} className={`${inputClass} w-40`} />
            </Field>
            <Field label="Até">
              <input type="date" name="ate" defaultValue={ate ?? ""} className={`${inputClass} w-40`} />
            </Field>
            <Field label="Usuário">
              <select name="usuario" defaultValue={userId ?? ""} className={`${inputClass} w-56`}>
                <option value="">Todos os usuários</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tipo de evento">
              <select name="tipo" defaultValue={eventType ?? ""} className={`${inputClass} w-56`}>
                <option value="">Todos os tipos</option>
                {eventTypes.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Origem">
              <select name="origem" defaultValue={origin ?? ""} className={`${inputClass} w-40`}>
                <option value="">Todas</option>
                <option value="frontend">Interface</option>
                <option value="backend">API</option>
              </select>
            </Field>
            <Field label="Tela">
              <input
                name="tela"
                defaultValue={screen ?? ""}
                className={`${inputClass} w-48`}
                placeholder="Ex.: /contas-a-pagar"
              />
            </Field>
            <Field label="Busca">
              <input
                name="q"
                defaultValue={q ?? ""}
                className={`${inputClass} w-56`}
                placeholder="Rótulo, tela, rota, elemento…"
              />
            </Field>
            <Button variant="secondary">Filtrar</Button>
            {anyFilterActive ? (
              <Link href="/auditoria?aba=atividade" className="text-sm text-[var(--brand)] underline">
                Limpar filtros
              </Link>
            ) : null}
          </form>
          {invalidRange ? (
            <p className="mt-3 text-xs text-amber-700">
              “De” é posterior a “Até” — o filtro de período foi ignorado.
            </p>
          ) : null}
        </Card>

        <Card title={`Eventos (${page.items.length} de ${page.total} — mais recentes primeiro)`}>
          {page.items.length === 0 ? (
            <EmptyState
              message={
                anyFilterActive
                  ? "Nenhum evento corresponde aos filtros selecionados."
                  : "Nenhum evento de atividade registrado ainda."
              }
            />
          ) : (
            <Table
              headers={["Quando", "Usuário", "Origem", "Evento", "Onde", "Detalhes"]}
              align={["l", "l", "l", "l", "l", "l"]}
            >
              {page.items.map((e) => {
                const expanded = expandedOf(e);
                return (
                  <tr key={e.id}>
                    <Td>{formatDateTime(e.timestamp)}</Td>
                    <Td>{e.userId ? (userName.get(e.userId) ?? e.userId) : "—"}</Td>
                    <Td>
                      <Badge tone="neutral">{ORIGIN_LABELS[e.origin] ?? e.origin}</Badge>
                    </Td>
                    <Td>
                      <span className="text-sm">{EVENT_TYPE_LABELS[e.eventType] ?? e.eventType}</span>
                      {e.label ? (
                        <span className="block text-[11px] text-[var(--ink-muted)]">“{e.label}”</span>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="text-xs">{whereOf(e)}</span>
                      {e.origin === "backend" && (e.status !== undefined || e.durationMs !== undefined) ? (
                        <span className="tabular block text-[11px] text-[var(--ink-muted)]">
                          {e.status !== undefined ? `HTTP ${e.status}` : ""}
                          {e.status !== undefined && e.durationMs !== undefined ? " · " : ""}
                          {e.durationMs !== undefined ? `${e.durationMs}ms` : ""}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {expanded ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-[var(--brand)]">detalhes</summary>
                          <pre className="mt-1 max-h-48 max-w-md overflow-auto rounded bg-slate-50 p-2 text-[11px]">
                            {smallJson(expanded)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-[var(--ink-muted)]">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
          <Pager page={page} basePath="/auditoria" extraQuery={extraQuery} />
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Aba TRILHA DE NEGÓCIO: a trilha imutável encadeada por hash (como antes).
  // -------------------------------------------------------------------------
  const entityType = params.entityType?.trim() || undefined;
  const entityId = params.entityId?.trim() || undefined;
  const actorId = params.ator?.trim() || undefined;
  const action = params.acao?.trim() || undefined;

  // Integridade: a cadeia é verificada sobre TODOS os registros da empresa
  // (o filtro vale apenas para a tabela — filtrar quebraria o encadeamento).
  const allRecords = await repos.audit.list(companyId);
  const chain = verifyChain(allRecords);

  // Tabela paginada no repositório (seq desc). Filtros aplicados no banco —
  // NUNCA passados a list()/verifyChain acima (isso quebraria o encadeamento).
  // Filtrar pelo nome canônico também tem de encontrar os registros gravados
  // com os nomes antigos (a trilha é append-only: reescrevê-los quebraria a
  // cadeia de hash, então a conciliação acontece aqui, na leitura).
  const page = await repos.audit.listPage(companyId, {
    offset: pageOffset(params.p),
    limit: PAGE_SIZE,
    entityType: entityType ? entityFilterAliases(entityType) : undefined,
    entityId,
    actorId,
    action: action ? actionFilterAliases(action) : undefined,
    from,
    to,
  });
  const rows = page.items;

  // Atores para o select: reaproveita `users` já carregado (sem 2ª consulta).
  const actorOptions = userOptions;
  // Ações para o select: derivadas das presentes na trilha (allRecords já em mão).
  // Opções do select já normalizadas: o legado não aparece como opção separada.
  const actionOptions = [...new Set(allRecords.map((r) => canonicalAction(r.action)))].sort();

  const anyFilterActive =
    Boolean(entityType) || Boolean(entityId) || Boolean(actorId) || Boolean(action) || Boolean(from) || Boolean(to);
  const extraQuery: Record<string, string | undefined> = {
    entityType,
    entityId,
    ator: actorId,
    acao: action,
    de: from,
    ate: to,
  };

  // Exportação leva os MESMOS filtros ativos (não a paginação).
  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(extraQuery)) if (v) exportParams.set(k, v);
  const exportHref = (format: "csv" | "pdf") => {
    const p = new URLSearchParams(exportParams);
    p.set("format", format);
    return `/api/v1/audit/export?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Auditoria"
        subtitle="Trilha imutável de tudo que aconteceu — cada registro encadeia o hash do anterior (adulteração é detectável)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={exportHref("csv")}
              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Exportar CSV
            </a>
            <a
              href={exportHref("pdf")}
              className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              Exportar PDF
            </a>
          </div>
        }
      />
      <Tabs active="trilha" />

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
        <form method="get" action="/auditoria" className="flex flex-wrap items-end gap-3">
          <Field label="De">
            <input type="date" name="de" defaultValue={de ?? ""} className={`${inputClass} w-40`} />
          </Field>
          <Field label="Até">
            <input type="date" name="ate" defaultValue={ate ?? ""} className={`${inputClass} w-40`} />
          </Field>
          <Field label="Ator">
            <select name="ator" defaultValue={actorId ?? ""} className={`${inputClass} w-56`}>
              <option value="">Todos os atores</option>
              {actorOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ação">
            <select name="acao" defaultValue={action ?? ""} className={`${inputClass} w-56`}>
              <option value="">Todas as ações</option>
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a] ?? a}
                </option>
              ))}
            </select>
          </Field>
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
          {anyFilterActive ? (
            <Link href="/auditoria" className="text-sm text-[var(--brand)] underline">
              Limpar filtros
            </Link>
          ) : null}
        </form>
        {invalidRange ? (
          <p className="mt-3 text-xs text-amber-700">
            “De” é posterior a “Até” — o filtro de período foi ignorado.
          </p>
        ) : null}
      </Card>

      <Card title={`Registros (${rows.length} de ${page.total} — mais recentes primeiro)`}>
        {rows.length === 0 ? (
          <EmptyState
            message={
              anyFilterActive
                ? "Nenhum registro corresponde aos filtros selecionados."
                : "Nenhum registro de auditoria."
            }
          />
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
                  {/* Rótulo em linguagem corrente; o código técnico fica abaixo,
                      apagado (quem investiga um incidente precisa do código exato). */}
                  <span className="text-sm">
                    {ACTION_LABELS[canonicalAction(r.action)] ?? r.action}
                  </span>
                  <span className="tabular block text-[11px] text-[var(--ink-muted)]">
                    {r.action}
                  </span>
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
        <Pager page={page} basePath="/auditoria" extraQuery={extraQuery} />
      </Card>
    </div>
  );
}
