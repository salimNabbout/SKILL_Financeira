import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Disciplina Fluxo de Caixa (CETEM) em modo demo: as cinco telas respondem,
 * parâmetros são gravados, a fila "A classificar" classifica em um clique e
 * as grades refletem o de-para.
 */

/** Aba da disciplina (o menu lateral também tem "Dashboard"; a aba fica na nav própria). */
function tab(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Telas do Fluxo de Caixa" }).getByRole("link", { name, exact: true });
}

/**
 * Substitui o valor de um MoneyInput. A máscara remonta o valor a partir dos
 * dígitos e, ao focar, leva o cursor para o fim — por isso `fill()` ANEXA ao
 * valor padrão em vez de substituir. Como um usuário: seleciona tudo e digita.
 */
async function typeMoney(input: Locator, digits: string) {
  await input.click();
  await input.press("Control+a");
  await input.pressSequentially(digits);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/$/);
}

test("telas, parâmetros, fila de classificação e grades do Fluxo de Caixa", async ({ page }) => {
  await login(page);

  // Menu e dashboard sem parâmetros gravados
  await page.getByRole("link", { name: "Fluxo de Caixa CETEM" }).click();
  await expect(page).toHaveURL(/\/fluxo-caixa(\?.*)?$/);
  await expect(page.getByRole("heading", { level: 1, name: "Fluxo de Caixa CETEM" })).toBeVisible();
  await expect(page.getByText(/Parâmetros do exercício não configurados/)).toBeVisible();
  await expect(page.getByText(/Dados calculados em/)).toBeVisible();

  // Parâmetros: grava saldo inicial, reserva e cenários
  await tab(page, "Parâmetros").click();
  await expect(page.getByRole("heading", { level: 1, name: "Parâmetros do Fluxo de Caixa" })).toBeVisible();
  const saldo = page.locator("#openingBalance");
  await typeMoney(saldo, "8500000");
  await expect(saldo).toHaveValue("85.000,00");
  const reserva = page.locator("#minimumReserve");
  await typeMoney(reserva, "6000000");
  await expect(reserva).toHaveValue("60.000,00");
  await page.fill('input[name="pessimista_receita"]', "-20,0");
  await page.getByRole("button", { name: "Gravar parâmetros e cenários" }).click();
  await expect(page.getByText(/Parâmetros e cenários gravados/)).toBeVisible();
  await expect(page.getByText(/Gravado \(v1\)/)).toBeVisible();
  await expect(page.locator("#openingBalance")).toHaveValue("85.000,00");
  await expect(page.locator("#minimumReserve")).toHaveValue("60.000,00");
  await expect(page.locator('input[name="pessimista_receita"]')).toHaveValue("-20,0");

  // Lançamentos: fila a_classificar com chaves do seed e classificação em um clique
  await tab(page, "Lançamentos").click();
  const fila = page.getByTestId("fila-classificar");
  await expect(fila).toBeVisible();
  const primeira = fila.locator("tbody tr").first();
  const chave = (await primeira.locator("td").first().innerText()).trim();
  await primeira.locator('select[name="categoryId"]').selectOption({ index: 1 });
  await primeira.getByRole("button", { name: "Classificar" }).click();
  await expect(page.getByText(new RegExp(`De-para criado: "${chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))).toBeVisible();
  await expect(page.getByTestId("fila-classificar").locator("tbody tr").filter({ hasText: chave })).toHaveCount(0);

  // Grade de lançamentos com origem e totais
  await expect(page.getByText(/lançamento\(s\) · entradas/)).toBeVisible();
  await expect(page.locator("table").last().locator("tbody tr").first()).toBeVisible();

  // Fluxo Mensal: grade com saldo encadeado partindo de 85.000,00
  await tab(page, "Fluxo Mensal").click();
  await expect(page.getByTestId("fluxo-mensal")).toBeVisible();
  await expect(page.getByText("Total de Entradas")).toBeVisible();
  await expect(page.getByText("Saldo Final", { exact: true })).toBeVisible();
  // Saldo Inicial de janeiro = parâmetro gravado; sem movimento em janeiro, Saldo Final = 85.000,00.
  await expect(page.getByTestId("saldo-final-1")).toHaveText("85.000,00");

  // Previsto × Realizado
  await tab(page, "Previsto × Realizado").click();
  await expect(page.getByTestId("previsto-realizado")).toBeVisible();
  await expect(page.getByText("Total de Saídas")).toBeVisible();

  // Dashboard configurado: KPIs e cenários
  await tab(page, "Dashboard").click();
  await expect(page.getByTestId("fc-kpis")).toBeVisible();
  await expect(page.getByText(/Saldo em 12 meses — pessimista/)).toBeVisible();
  await expect(page.getByText(/Parâmetros do exercício não configurados/)).toHaveCount(0);
});
