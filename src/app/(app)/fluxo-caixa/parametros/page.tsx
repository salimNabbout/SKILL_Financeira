import { Badge, Button, Card, Field, PageHeader, Table, Td, inputClass } from "@/components/ui";
import { MoneyInput } from "@/components/money-input";
import { getContainer } from "@/lib/container";
import { requireSession } from "@/lib/session";
import { hasPermission } from "@/core/auth";
import { CASHFLOW_GROUP_LABEL } from "@/core/cashflow";
import { formatDateTime } from "@/lib/format";
import { getCashflowParameters, listCashflowCategories, listCashflowMappings, loadCashflowContext } from "@/app/api/_lib/cashflow";
import { Flash } from "@/app/(app)/cadastros/_lib/flash";
import { saveMappingAction, saveParametersAction } from "../actions";
import { BASE, CategorySelect, ComputedAt, FluxoTabs, HeaderActions, bpToField } from "../_lib/shared";

const SOURCE_LABEL: Record<string, string> = {
  plano_contas: "Plano contábil (id da categoria)",
  categoria_ap: "Categoria a PAGAR (texto)",
  categoria_ar: "Categoria a RECEBER (id)",
  regra_texto: "Regra por texto na descrição",
};

/**
 * Parâmetros — saldo inicial, reserva mínima, ano base, override de meses
 * realizados, cenários (premissas em %) e o de-para de categorias. Premissas
 * destacadas: alteram todos os resultados. Escrita exige `budget.manage`.
 */
export default async function ParametrosPage({
  searchParams,
}: {
  searchParams: Promise<{ ano?: string; ok?: string; erro?: string }>;
}) {
  const sp = await searchParams;
  const session = await requireSession();
  const container = await getContainer();
  const { parameter, scenarios } = await getCashflowParameters(container, session, sp.ano ? { ano: sp.ano } : {});
  const year = parameter.year;
  const ctx = await loadCashflowContext(container, session, year);
  const years = [...new Set([...ctx.entries.map((e) => e.year), year])].sort((a, b) => a - b);
  const categories = await listCashflowCategories(container, session);
  const mappings = await listCashflowMappings(container, session);
  const podeEditar = hasPermission(session.membership.role, "budget.manage");
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const toReais = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
  const returnTo = `${BASE}/parametros?ano=${year}`;

  return (
    <div>
      <PageHeader
        title="Parâmetros do Fluxo de Caixa"
        subtitle="Saldo inicial, reserva mínima, meses realizados, cenários e o de-para de categorias. Nada aqui é constante no código."
        actions={<HeaderActions ano={year} years={years} path={`${BASE}/parametros`} />}
      />
      <FluxoTabs active="parametros" ano={year} />
      <Flash ok={sp.ok} erro={sp.erro} />
      {!podeEditar ? (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Seu papel não permite alterar parâmetros do fluxo de caixa — visualização apenas.
        </p>
      ) : null}

      <Card className="mb-6" title={`Exercício ${year}`}>
        <form action={saveParametersAction} className="grid gap-4 md:grid-cols-3">
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="version" value={parameter.version} />
          <div className="md:col-span-3 rounded-lg border-2 border-amber-300 bg-amber-50 p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-800">
              Premissas — alteram TODOS os resultados (Fluxo Mensal, Projeção, Dashboard e alertas)
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Saldo inicial do exercício (R$)">
                <MoneyInput name="openingBalance" id="openingBalance" required defaultValue={toReais(parameter.openingBalanceCents)} className={inputClass} />
                <span className="mt-1 block text-xs text-[var(--ink-muted)]">Saldo Inicial de janeiro; os demais meses encadeiam.</span>
              </Field>
              <Field label="Reserva mínima (R$)">
                <MoneyInput name="minimumReserve" id="minimumReserve" required defaultValue={toReais(parameter.minimumReserveCents)} className={inputClass} />
                <span className="mt-1 block text-xs text-[var(--ink-muted)]">Saldo Final abaixo disto = "Abaixo da reserva".</span>
              </Field>
              <Field label="Meses realizados (override)">
                <input name="realizedMonthsOverride" id="realizedMonthsOverride" type="number" min={0} max={12} defaultValue={parameter.realizedMonthsOverride ?? ""} className={inputClass} placeholder="vazio = calculado" />
                <span className="mt-1 block text-xs text-[var(--ink-muted)]">Vazio: o sistema conta os meses com movimento realizado.</span>
              </Field>
            </div>
          </div>

          <div className="md:col-span-3">
            <p className="mb-2 text-sm font-medium">Cenários de projeção (premissas em %)</p>
            <Table headers={["Cenário", "Ajuste de receita (%)", "Ajuste de despesa (%)", "Crescimento mensal (%)", "Situação"]}>
              {scenarios.map((s) => (
                <tr key={s.code}>
                  <Td>
                    <span className="font-medium">{s.name}</span>
                    <input type="hidden" name={`${s.code}_version`} value={s.version} />
                  </Td>
                  <Td><input name={`${s.code}_receita`} defaultValue={bpToField(s.revenueAdjustmentBp)} className={`${inputClass} !w-28`} inputMode="decimal" /></Td>
                  <Td><input name={`${s.code}_despesa`} defaultValue={bpToField(s.expenseAdjustmentBp)} className={`${inputClass} !w-28`} inputMode="decimal" /></Td>
                  <Td><input name={`${s.code}_crescimento`} defaultValue={bpToField(s.monthlyGrowthBp)} className={`${inputClass} !w-28`} inputMode="decimal" /></Td>
                  <Td><Badge tone={s.configured ? "ok" : "neutral"}>{s.configured ? `gravado (v${s.version})` : "padrão da planilha"}</Badge></Td>
                </tr>
              ))}
            </Table>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              Fórmulas: entradas_i = média × (1 + ajuste de receita) × (1 + crescimento)^i; saídas_i = média × (1 + ajuste de despesa) × (1 + crescimento)^i.
            </p>
          </div>

          <div className="flex items-end gap-3 md:col-span-3">
            <Button type="submit" variant="warn">Gravar parâmetros e cenários</Button>
            <span className="text-xs text-[var(--ink-muted)]">
              {parameter.configured
                ? `Gravado (v${parameter.version})${parameter.updatedAt ? ` em ${formatDateTime(parameter.updatedAt)}` : ""}.`
                : "Ainda não gravado: os valores acima são padrões."}
            </span>
          </div>
        </form>
      </Card>

      <Card className="mb-6" title={`De-para de categorias (${mappings.length})`}>
        <p className="mb-3 text-sm text-[var(--ink-muted)]">
          Liga o que o app já tem (categoria de fornecedor, categoria a receber, plano contábil, texto da descrição) ao plano da planilha.
          Chave sem de-para cai em <strong>A Classificar</strong> e aparece na fila da tela Lançamentos.
        </p>
        {mappings.length === 0 ? (
          <p className="mb-3 text-sm text-[var(--ink-muted)]">Nenhum de-para gravado.</p>
        ) : (
          <Table headers={["Origem", "Chave", "Categoria", "Prioridade", "Ativo", "Versão", ""]}>
            {mappings.map((mp) => (
              <tr key={mp.id}>
                <Td>{SOURCE_LABEL[mp.source] ?? mp.source}</Td>
                <Td><span className="font-mono text-xs">{mp.sourceKey}</span></Td>
                <Td>
                  <form action={saveMappingAction} className="flex flex-wrap items-center gap-1">
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="source" value={mp.source} />
                    <input type="hidden" name="sourceKey" value={mp.sourceKey} />
                    <input type="hidden" name="version" value={mp.version} />
                    <CategorySelect name="categoryId" categories={categories} defaultValue={mp.categoryId} includeNeutral className={`${inputClass} !w-56 !py-1 !text-xs`} required />
                    <input name="priority" type="number" min={0} defaultValue={mp.priority} className={`${inputClass} !w-16 !py-1 !text-xs`} title="Prioridade (menor = avaliada antes)" />
                    <select name="active" defaultValue={mp.active ? "1" : "0"} className={`${inputClass} !w-20 !py-1 !text-xs`}>
                      <option value="1">ativo</option>
                      <option value="0">inativo</option>
                    </select>
                    {podeEditar ? (
                      <span className="[&>button]:!px-2 [&>button]:!py-1 [&>button]:!text-xs">
                        <Button variant="warn" type="submit">Salvar</Button>
                      </span>
                    ) : null}
                  </form>
                </Td>
                <Td>{mp.priority}</Td>
                <Td><Badge tone={mp.active ? "ok" : "neutral"}>{mp.active ? "ativo" : "inativo"}</Badge></Td>
                <Td>v{mp.version}</Td>
                <Td><span className="text-xs text-[var(--ink-muted)]">{catName.get(mp.categoryId) ?? mp.categoryId}</span></Td>
              </tr>
            ))}
          </Table>
        )}
        {podeEditar ? (
          <form action={saveMappingAction} className="mt-4 grid gap-3 rounded-lg border border-[var(--line)] p-3 md:grid-cols-4">
            <input type="hidden" name="returnTo" value={returnTo} />
            <Field label="Origem">
              <select name="source" className={inputClass} defaultValue="categoria_ap">
                {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="Chave de origem">
              <input name="sourceKey" required className={inputClass} placeholder="Ex.: Concessionaria - Energia" />
            </Field>
            <Field label="Categoria do plano">
              <CategorySelect name="categoryId" categories={categories} includeNeutral className={inputClass} required />
            </Field>
            <div className="flex items-end gap-2">
              <input name="priority" type="number" min={0} defaultValue={100} className={`${inputClass} !w-20`} title="Prioridade (regras por texto)" />
              <Button type="submit">Adicionar</Button>
            </div>
          </form>
        ) : null}
      </Card>

      <Card className="mb-6" title="Plano de categorias da planilha (referência)">
        <details>
          <summary className="cursor-pointer text-sm text-[var(--brand)]">Ver as {categories.length} categorias</summary>
          <div className="mt-2">
            <Table headers={["Ordem", "Categoria", "Tipo", "Grupo", "Classificação", "Situação"]}>
              {categories.map((c) => (
                <tr key={c.id}>
                  <Td>{c.sortOrder}</Td>
                  <Td>{c.name} <span className="font-mono text-[10px] text-[var(--ink-muted)]">{c.id}</span></Td>
                  <Td>{c.kind}</Td>
                  <Td>{CASHFLOW_GROUP_LABEL[c.group]}</Td>
                  <Td>{c.classification}</Td>
                  <Td><Badge tone={c.active ? "ok" : "neutral"}>{c.active ? "ativa" : "inativa"}</Badge></Td>
                </tr>
              ))}
            </Table>
          </div>
        </details>
        <ComputedAt iso={ctx.computedAt} />
      </Card>
    </div>
  );
}
