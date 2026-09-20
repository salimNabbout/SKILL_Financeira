import Link from "next/link";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { MoneyInput } from "@/components/money-input";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { CASHFLOW_GROUP_LABEL, CASHFLOW_UNCLASSIFIED_ID } from "@/core/cashflow";
import { formatBR, formatBRL } from "@/lib/format";
import { getCashflowPending, listCashflowCategories, listCashflowEntries } from "@/app/api/_lib/cashflow";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { PAGE_SIZE, Pager, pageOffset } from "@/app/(app)/_lib/pager";
import { createManualEntryAction, deleteManualEntryAction, saveMappingAction, updateManualEntryAction } from "../actions";
import { BASE, CategorySelect, ComputedAt, FluxoTabs, ORIGEM_LABEL, OrigemBadge, STATUS_LABEL, HeaderActions } from "../_lib/shared";

const SOURCE_SHORT: Record<string, string> = {
  plano_contas: "plano contábil",
  categoria_ap: "categoria a pagar",
  categoria_ar: "categoria a receber",
  regra_texto: "texto da descrição",
};

/**
 * Lançamentos — grade filtrável da unificação, com badge de origem e link
 * para o registro original; fila `a_classificar` no topo com classificação em
 * um clique (grava em fc_mapeamento); ajustes manuais criados/alterados aqui,
 * visualmente distintos dos derivados.
 */
export default async function LancamentosPage({
  searchParams,
}: {
  searchParams: Promise<{
    ano?: string; mes?: string; categoria?: string; status?: string; origem?: string; centro_custo?: string;
    p?: string; editar?: string; excluir?: string; ok?: string; erro?: string;
  }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const container = await getContainer();
  const offset = pageOffset(sp.p, PAGE_SIZE);
  const query: Record<string, string> = { offset: String(offset), limit: String(PAGE_SIZE) };
  for (const k of ["ano", "mes", "categoria", "status", "origem", "centro_custo"] as const) if (sp[k]) query[k] = sp[k]!;
  const page = await listCashflowEntries(container, session, query);
  const pending = await getCashflowPending(container, session, { ano: String(page.year) });
  const categories = await listCashflowCategories(container, session);
  const costCenters = (await container.repos.costCenters.listAll(session.company.id)).filter((c) => c.active);
  const podeEditar = hasPermission(session.membership.role, "budget.manage");
  const catById = new Map(categories.map((c) => [c.id, c]));
  const ccCode = new Map(costCenters.map((c) => [c.id, c.code]));
  const filtros = { ano: String(page.year), mes: sp.mes, categoria: sp.categoria, status: sp.status, origem: sp.origem, centro_custo: sp.centro_custo };
  const qsFiltros = new URLSearchParams(Object.entries(filtros).filter((kv): kv is [string, string] => Boolean(kv[1])));
  const returnTo = `${BASE}/lancamentos?${qsFiltros.toString()}`;
  const editandoId = sp.editar?.trim() || undefined;
  const editando = editandoId ? await container.repos.cashflowManualEntries.getById(session.company.id, editandoId) : null;
  const excluindoId = sp.excluir?.trim() || undefined;
  const toReais = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

  return (
    <div>
      <PageHeader
        title="Lançamentos do Fluxo de Caixa"
        subtitle={`Ano base ${page.year} — cada evento de caixa aparece uma única vez, com a origem e o critério de casamento.`}
        actions={<HeaderActions ano={page.year} years={page.years} path={`${BASE}/lancamentos`} importar />}
      />
      <FluxoTabs active="lancamentos" ano={page.year} />
      <Flash ok={sp.ok} erro={sp.erro} />

      {/* Fila de revisão: a_classificar */}
      <Card className="mb-6" title={pending.total === 0 ? "A classificar: nenhuma pendência" : `A classificar: ${pending.total} lançamento(s) · ${formatBRL(pending.totalCents)}`}>
        {pending.total === 0 ? (
          <p className="text-sm text-[var(--ink-muted)]">Todos os lançamentos do ano têm categoria mapeada.</p>
        ) : (
          <div className="space-y-2" data-testid="fila-classificar">
            <p className="text-sm text-[var(--ink-muted)]">
              Cada linha é uma chave de origem sem de-para. Escolher a categoria grava a regra e classifica todos os lançamentos da chave, agora e no futuro.
            </p>
            <Table headers={["Chave de origem", "Tipo de chave", "Lançamentos", "Total", "Exemplos", "Categoria do plano"]}>
              {pending.groups.map((g) => (
                <tr key={`${g.source}:${g.sourceKey}`}>
                  <Td><span className="font-mono text-xs">{g.sourceKey}</span></Td>
                  <Td>{SOURCE_SHORT[g.source] ?? g.source}</Td>
                  <Td>{g.count}</Td>
                  <Td right>{formatBRL(g.totalCents)}</Td>
                  <Td><span className="text-xs text-[var(--ink-muted)]">{g.samples.join(" · ")}</span></Td>
                  <Td>
                    {podeEditar ? (
                      <form action={saveMappingAction} className="flex items-center gap-1">
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="source" value={g.source} />
                        <input type="hidden" name="sourceKey" value={g.sourceKey} />
                        <CategorySelect name="categoryId" categories={categories} includeNeutral onlyKind={g.kinds.length === 1 ? g.kinds[0] : undefined} className={`${inputClass} !w-60 !py-1 !text-xs`} required />
                        <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                          <Button type="submit">Classificar</Button>
                        </span>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--ink-muted)]">sem permissão</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      {/* Filtros */}
      <Card className="mb-4" title="Filtros">
        <form method="get" action={`${BASE}/lancamentos`} className="grid gap-3 md:grid-cols-6">
          <input type="hidden" name="ano" value={page.year} />
          <Field label="Mês">
            <select name="mes" defaultValue={sp.mes ?? ""} className={inputClass}>
              <option value="">Todos</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{String(i + 1).padStart(2, "0")}</option>
              ))}
            </select>
          </Field>
          <Field label="Categoria">
            <select name="categoria" defaultValue={sp.categoria ?? ""} className={inputClass}>
              <option value="">Todas</option>
              {categories.filter((c) => c.kind !== "neutro").map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
              <option value="">Todos</option>
              <option value="previsto">Previsto</option>
              <option value="realizado">Realizado</option>
            </select>
          </Field>
          <Field label="Origem">
            <select name="origem" defaultValue={sp.origem ?? ""} className={inputClass}>
              <option value="">Todas</option>
              {Object.entries(ORIGEM_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Centro de custo">
            <select name="centro_custo" defaultValue={sp.centro_custo ?? ""} className={inputClass}>
              <option value="">Todos</option>
              {costCenters.map((c) => (
                <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
              ))}
            </select>
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Filtrar</Button>
            <Link href={`${BASE}/lancamentos?ano=${page.year}`} className="text-sm text-[var(--brand)] underline">Limpar</Link>
          </div>
        </form>
      </Card>

      {/* Grade */}
      <Card className="mb-6" title={`${page.total} lançamento(s) · entradas ${formatBRL(page.totals.entradasCents)} · saídas ${formatBRL(page.totals.saidasCents)} · líquido ${formatBRL(page.totals.liquidoCents)}`}>
        {page.items.length === 0 ? (
          <EmptyState message="Nenhum lançamento para os filtros informados." />
        ) : (
          <Table headers={["Data de caixa", "Competência", "Descrição", "Categoria", "Grupo", "Status", "Origem", "Centro", "Valor"]} align={["l", "l", "l", "l", "l", "l", "l", "l", "r"]}>
            {page.items.map((e) => {
              const cat = catById.get(e.categoryId);
              const manual = e.origin === "ajuste_manual";
              return (
                <tr key={`${e.origin}:${e.originId}:${e.amountCents}`} className={manual ? "bg-amber-50/60" : ""}>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs">{formatBR(e.cashDate)}</Td>
                  <Td className="whitespace-nowrap !px-2 !py-1 text-xs text-[var(--ink-muted)]">{formatBR(e.competenceDate)}</Td>
                  <Td className="max-w-[320px] truncate !px-2 !py-1 text-xs"><span title={e.matchCriteria ? `${e.description} — ${e.matchCriteria}` : e.description}>{e.description}</span></Td>
                  <Td className="!px-2 !py-1 text-xs">
                    {e.categoryId === CASHFLOW_UNCLASSIFIED_ID ? <Badge tone="warn">A Classificar</Badge> : (cat?.name ?? e.categoryId)}
                  </Td>
                  <Td className="!px-2 !py-1 text-xs text-[var(--ink-muted)]">{CASHFLOW_GROUP_LABEL[e.group]}</Td>
                  <Td className="!px-2 !py-1 text-xs">
                    <Badge tone={e.status === "realizado" ? "ok" : "neutral"}>{STATUS_LABEL[e.status]}</Badge>
                    {e.realizedBy === "baixa_app" ? <span className="ml-1 text-[10px] text-[var(--ink-muted)]" title="Realizado pela baixa no app, sem conciliação bancária">baixa no app</span> : null}
                  </Td>
                  <Td className="!px-2 !py-1 text-xs">
                    <OrigemBadge e={e} />
                    {manual && podeEditar ? (
                      <Link href={`${returnTo}&editar=${encodeURIComponent(e.originId)}`} className="ml-1 text-xs text-[var(--brand)] underline">editar</Link>
                    ) : null}
                  </Td>
                  <Td className="!px-2 !py-1 text-xs">{e.costCenterId ? (ccCode.get(e.costCenterId) ?? e.costCenterId) : "—"}</Td>
                  <Td right className={`whitespace-nowrap !px-2 !py-1 text-xs ${e.kind === "entrada" ? "text-[var(--ok)]" : "text-[var(--crit)]"}`}>
                    {e.kind === "entrada" ? "+" : "−"} {formatBRL(e.amountCents)}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={{ total: page.total, offset: page.offset, limit: page.limit }} basePath={`${BASE}/lancamentos`} param="p" extraQuery={filtros} />
        <ComputedAt iso={page.computedAt} />
      </Card>

      {/* Ajustes manuais */}
      {podeEditar ? (
        <Card className="mb-6" title={editando ? "Editar ajuste manual" : "Novo ajuste manual"}>
          <p className="mb-3 text-sm text-[var(--ink-muted)]">
            Para lançamentos que não existem em nenhum módulo (aporte de sócio previsto, compra planejada ainda sem título). Aparecem destacados na grade.
          </p>
          <form action={editando ? updateManualEntryAction : createManualEntryAction} className="grid gap-3 md:grid-cols-4">
            <input type="hidden" name="returnTo" value={returnTo} />
            {editando ? <input type="hidden" name="id" value={editando.id} /> : null}
            {editando ? <input type="hidden" name="version" value={editando.version} /> : null}
            <Field label="Data (competência)">
              <input type="date" name="competenceDate" required defaultValue={editando?.competenceDate ?? ""} className={inputClass} />
            </Field>
            <Field label="Tipo">
              <select name="kind" defaultValue={editando?.kind ?? "saida"} className={inputClass}>
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
              </select>
            </Field>
            <Field label="Categoria do plano">
              <CategorySelect name="categoryId" categories={categories} defaultValue={editando?.categoryId} className={inputClass} required />
            </Field>
            <Field label="Status">
              <select name="status" defaultValue={editando?.status ?? "previsto"} className={inputClass}>
                <option value="previsto">Previsto</option>
                <option value="realizado">Realizado</option>
              </select>
            </Field>
            <Field label="Descrição">
              <input name="description" required defaultValue={editando?.description ?? ""} className={inputClass} />
            </Field>
            <Field label="Valor (R$, sempre positivo)">
              <MoneyInput name="amount" required defaultValue={editando ? toReais(editando.amountCents) : ""} className={inputClass} />
            </Field>
            <Field label="Centro de custo">
              <select name="costCenterId" defaultValue={editando?.costCenterId ?? ""} className={inputClass}>
                <option value="">—</option>
                {costCenters.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Observação de origem">
              <input name="sourceNote" defaultValue={editando?.sourceNote ?? ""} className={inputClass} placeholder="Ex.: contrato assinado em 10/09" />
            </Field>
            <div className="flex items-end gap-2 md:col-span-4">
              <Button type="submit" variant={editando ? "warn" : "primary"}>{editando ? "Salvar alterações" : "Adicionar ajuste"}</Button>
              {editando ? (
                <Link href={returnTo} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Cancelar</Link>
              ) : null}
              {editando ? (
                <Link href={`${returnTo}&excluir=${encodeURIComponent(editando.id)}`} className="text-sm text-[var(--crit)] underline">Excluir…</Link>
              ) : null}
            </div>
          </form>
          {excluindoId && editando && excluindoId === editando.id ? (
            <form action={deleteManualEntryAction} className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
              <input type="hidden" name="id" value={editando.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <p className="mb-2 text-sm text-[var(--crit)]">
                Excluir o ajuste &quot;{editando.description}&quot; ({formatBRL(editando.amountCents)})? O valor anterior fica guardado na auditoria.
              </p>
              <div className="flex gap-2">
                <Button variant="danger" type="submit">Confirmar exclusão</Button>
                <Link href={`${returnTo}&editar=${encodeURIComponent(editando.id)}`} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Voltar</Link>
              </div>
            </form>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
