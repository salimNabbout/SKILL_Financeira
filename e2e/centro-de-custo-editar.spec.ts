import { expect, test } from "@playwright/test";

/**
 * Centro de custo: cadastro com destino e edição inline.
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

test("editar centro de custo altera destino e situação", async ({ page }) => {
  await login(page);

  const marca = Date.now();
  const code = `ED-${marca}`;
  await cadastrar(page, code, "Para editar", "both");

  const linha = page.getByRole("row", { name: new RegExp(code) });
  await linha.getByRole("button", { name: "Editar" }).click();

  await page.selectOption('select[name="scope"]', "receivable");
  await page.selectOption('select[name="active"]', "false");
  await page.getByRole("button", { name: "Salvar" }).click();

  await expect(page.locator("p.border-emerald-200")).toContainText("atualizado");
  const atualizada = page.getByRole("row", { name: new RegExp(code) });
  await expect(atualizada).toContainText("Contas a receber");
  await expect(atualizada).toContainText("Inativo");

  // Inativo não é oferecido em lançamento novo.
  await page.goto("/contas-a-receber");
  const opcoes = await page
    .locator('select[name="costCenterId"] option')
    .evaluateAll((os) => os.map((o) => o.textContent ?? ""));
  expect(opcoes.some((t) => t.includes(code))).toBe(false);
});
