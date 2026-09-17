import { expect, test } from "@playwright/test";

/**
 * Painel por Período (topo do Dashboard) em modo demonstração.
 *
 * O seed demo tem 2 pagamentos executados e 2 recebimentos no MÊS ANTERIOR
 * (datas relativas a hoje em America/Sao_Paulo):
 *   pay_seed_1  R$ 7.800,00  variável  Insumos  cc_loja  em lastMonth
 *   pay_seed_2  R$ 1.395,20  fixo      Energia  cc_loja  em lastMonth + 2 dias
 *   rcp_seed_1  R$ 4.870,00                              em lastMonth + 1 dia
 *   rcp_seed_2  R$ 6.230,00                              em lastMonth + 4 dias
 * Perto do fim do mês algumas dessas datas caem no mês corrente; o teste
 * recalcula os valores esperados com a mesma regra de calendário.
 */

type Page = import("@playwright/test").Page;

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brl = (cents: number) => BRL.format(cents / 100).replace(/ /g, " ");

function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function noon(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}
function addDays(iso: string, days: number): string {
  const d = noon(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Mesma regra de @/core/dates.addMonths: trava no último dia do mês. */
function addMonths(iso: string, months: number): string {
  const d = noon(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function daysInMonth(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);
}

/** Valor exibido num StatCard do painel, pelo rótulo. */
function statValue(page: Page, label: string) {
  return page
    .locator("#painel-periodo .card")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("p.tabular")
    .first();
}

function panelResponse(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes("/api/v1/dashboard/period-panel") && r.status() === 200
  );
}

test("filtros, totais, gráfico, cascata de categoria e URL do Painel por Período", async ({ page }) => {
  const today = todayInSaoPaulo();
  const lastMonth = addMonths(today, -1);
  const seeds = {
    pay1: { date: lastMonth, cents: 780_000, cls: "variable", cat: "Insumos" },
    pay2: { date: addDays(lastMonth, 2), cents: 139_520, cls: "fixed", cat: "Energia" },
    rcp1: { date: addDays(lastMonth, 1), cents: 487_000 },
    rcp2: { date: addDays(lastMonth, 4), cents: 623_000 },
  };
  const ano = Number(lastMonth.slice(0, 4));
  const mes = Number(lastMonth.slice(5, 7));
  const noMes = (iso: string) => iso.slice(0, 7) === lastMonth.slice(0, 7);
  const pagos = [seeds.pay1, seeds.pay2].filter((p) => noMes(p.date));
  const recebidos = [seeds.rcp1, seeds.rcp2].filter((r) => noMes(r.date));
  const totalPago = pagos.reduce((s, p) => s + p.cents, 0);
  const fixo = pagos.filter((p) => p.cls === "fixed").reduce((s, p) => s + p.cents, 0);
  const variavel = pagos.filter((p) => p.cls === "variable").reduce((s, p) => s + p.cents, 0);
  const totalRecebido = recebidos.reduce((s, r) => s + r.cents, 0);

  await login(page);
  const painel = page.locator("#painel-periodo");
  await expect(painel.getByText("Painel por Período", { exact: false })).toBeVisible();

  // Padrão ao abrir: ano e mês correntes, dia 1 até o último dia.
  await expect(painel.locator('select[name="ano"]')).toHaveValue(today.slice(0, 4));
  await expect(painel.locator('select[name="mes"]')).toHaveValue(String(Number(today.slice(5, 7))));
  await expect(painel.locator('select[name="de"]')).toHaveValue("1");
  await expect(painel.locator('select[name="ate"]')).toHaveValue(
    String(daysInMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7))))
  );

  // Trocar para o mês anterior atualiza totais e gráfico sem recarregar (fetch ao endpoint).
  if (String(ano) !== today.slice(0, 4)) {
    const r = panelResponse(page);
    await painel.locator('select[name="ano"]').selectOption(String(ano));
    await r;
  }
  const resp = panelResponse(page);
  await painel.locator('select[name="mes"]').selectOption(String(mes));
  await resp;
  await expect(statValue(page, "Total Pago no período")).toHaveText(brl(totalPago));
  await expect(statValue(page, "Total Recebido no período")).toHaveText(brl(totalRecebido));
  await expect(statValue(page, "Custo Fixo pago")).toHaveText(brl(fixo));
  await expect(statValue(page, "Custo Variável pago")).toHaveText(brl(variavel));
  // Gráfico com as 4 barras rotuladas (ou estado vazio se o mês não tiver nada).
  if (totalPago + totalRecebido > 0) {
    await expect(painel.locator('svg[role="img"] [data-bar="Pago"] text').first()).toHaveText(brl(totalPago));
    await expect(painel.locator('svg[role="img"] [data-bar="Recebido"]')).toHaveCount(1);
  } else {
    await expect(painel.getByText("Sem movimentação no período selecionado")).toBeVisible();
  }

  // URL guarda a seleção; recarregar mantém.
  await expect(page).toHaveURL(new RegExp(`ano=${ano}&mes=${mes}&de=1&ate=${daysInMonth(ano, mes)}`));
  await page.reload();
  await expect(painel.locator('select[name="mes"]')).toHaveValue(String(mes));
  await expect(statValue(page, "Total Pago no período")).toHaveText(brl(totalPago));

  // Cascata: centro de custo "cc_loja" → só as categorias com movimento nele.
  if (pagos.length > 0) {
    const r2 = panelResponse(page);
    await painel.locator('select[name="cc"]').selectOption("cc_loja");
    await r2;
    await expect(statValue(page, "Total Gasto no Centro de Custo")).toHaveText(brl(totalPago));
    const opcoes = await painel.locator('select[name="cat"] option').allTextContents();
    expect(opcoes[0]).toBe("Todos");
    expect(opcoes.slice(1).sort()).toEqual(pagos.map((p) => p.cat).sort());
    // Ranking das categorias visível com "Todos"; total por categoria = total do centro.
    await expect(statValue(page, "Total Gasto por Categoria")).toHaveText(brl(totalPago));
    const escolhida = pagos[0];
    const r3 = panelResponse(page);
    await painel.locator('select[name="cat"]').selectOption(escolhida.cat);
    await r3;
    await expect(statValue(page, "Total Gasto por Categoria")).toHaveText(brl(escolhida.cents));
    // Os 4 totais e o gráfico NÃO reagem ao centro/categoria.
    await expect(statValue(page, "Total Pago no período")).toHaveText(brl(totalPago));
    await expect(page).toHaveURL(/cc=cc_loja/);
    await expect(page).toHaveURL(new RegExp(`cat=${encodeURIComponent(escolhida.cat)}`));

    // Dia inicial = dia final = dia do primeiro pagamento → só ele.
    const dia = Number(escolhida.date.slice(8, 10));
    const r4 = panelResponse(page);
    await painel.locator('select[name="de"]').selectOption(String(dia));
    await r4;
    const r5 = panelResponse(page);
    await painel.locator('select[name="ate"]').selectOption(String(dia));
    await r5;
    await expect(statValue(page, "Total Pago no período")).toHaveText(brl(escolhida.cents));
  }

  // Mês "Todos": dias desabilitados; mês sem movimento (3 meses atrás) mostra o estado vazio.
  const r6 = panelResponse(page);
  await painel.locator('select[name="mes"]').selectOption("todos");
  await r6;
  await expect(painel.locator('select[name="de"]')).toBeDisabled();
  await expect(painel.locator('select[name="ate"]')).toBeDisabled();
  await expect(page).toHaveURL(/mes=todos/);

  const vazio = addMonths(today, -3);
  if (vazio.slice(0, 4) !== String(ano)) {
    const r = panelResponse(page);
    await painel.locator('select[name="ano"]').selectOption(vazio.slice(0, 4));
    await r;
  }
  const r7 = panelResponse(page);
  await painel.locator('select[name="mes"]').selectOption(String(Number(vazio.slice(5, 7))));
  await r7;
  await expect(painel.getByText("Sem movimentação no período selecionado")).toBeVisible();
  await expect(statValue(page, "Total Pago no período")).toHaveText(brl(0));

  // Rodapé no padrão do app: Fontes e Suposições.
  await expect(painel.getByText(/Fontes:/)).toBeVisible();
  await expect(painel.getByText(/Regime de CAIXA/)).toBeVisible();
});

test("os cards antigos do dashboard continuam presentes abaixo do painel", async ({ page }) => {
  await login(page);
  for (const label of ["Saldo disponível", "Comprometido", "A pagar (7 dias)", "A receber (7 dias)"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Entradas × saídas — próximas 4 semanas")).toBeVisible();
  await expect(page.getByText("Alertas abertos")).toBeVisible();
  await expect(page.getByText("Aprovações pendentes")).toBeVisible();
  // Card Saldo disponível com a fonte expansível (Fase 2).
  await page.getByText("Ver detalhes (fonte)").click();
  await expect(page.getByText("Provedor bancário ativo:")).toBeVisible();
});
