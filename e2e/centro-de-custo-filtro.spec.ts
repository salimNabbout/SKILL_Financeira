import { expect, test } from "@playwright/test";

/**
 * Destino do centro de custo filtrando os selects de lançamento.
 *
 * O ponto mais delicado é o 5.4: mudar o destino NÃO pode desvincular títulos
 * já lançados — o filtro vale só para lançamentos novos.
 *
 * Modo demonstração (DEMO_MODE=1), dados em memória.
 */

type Page = import("@playwright/test").Page;

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);
}

async function cadastrar(page: Page, code: string, nome: string, scope: string) {
  await page.goto("/cadastros/centros-de-custo");
  await page.fill('input[name="code"]', code);
  await page.fill('input[name="name"]', nome);
  await page.selectOption('select[name="scope"]', scope);
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("cell", { name: code })).toBeVisible();
}

test("destino do centro de custo filtra os selects de lançamento", async ({ page }) => {
  await login(page);

  const marca = Date.now();
  const soPagar = `PG-${marca}`;
  const soReceber = `RC-${marca}`;

  await cadastrar(page, soPagar, "Só a pagar", "payable");
  await cadastrar(page, soReceber, "Só a receber", "receivable");

  // A coluna Destino mostra o rótulo em português.
  await expect(page.getByRole("row", { name: new RegExp(soReceber) })).toContainText(
    "Contas a receber"
  );

  // O formulário de novo título só é renderizado com fornecedor E categoria de
  // fornecedor cadastrados (ver proteção contra select `required` vazio).
  await page.goto("/cadastros/categorias-fornecedores");
  await page.fill('input[name="name"]', "Insumos Gerais");
  await page.getByRole("button", { name: "Adicionar" }).click();

  // Em Contas a Pagar aparece o de "payable" e não o de "receivable".
  await page.goto("/contas-a-pagar");
  const opcoesPagar = await page
    .locator('select[name="costCenterId"] option')
    .evaluateAll((os) => os.map((o) => o.textContent ?? ""));
  expect(opcoesPagar.some((t) => t.includes(soPagar))).toBe(true);
  expect(opcoesPagar.some((t) => t.includes(soReceber))).toBe(false);

  // Em Contas a Receber, o inverso.
  await page.goto("/contas-a-receber");
  const opcoesReceber = await page
    .locator('select[name="costCenterId"] option')
    .evaluateAll((os) => os.map((o) => o.textContent ?? ""));
  expect(opcoesReceber.some((t) => t.includes(soReceber))).toBe(true);
  expect(opcoesReceber.some((t) => t.includes(soPagar))).toBe(false);
});
