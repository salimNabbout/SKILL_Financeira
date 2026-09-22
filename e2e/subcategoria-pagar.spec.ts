import { expect, test, type Page } from "@playwright/test";

/**
 * Cadastro "Subcategoria a PAGAR" → caixa SUBCATEGORIA do novo título:
 * o que é cadastrado aparece como opção na caixa e é gravado no título.
 * Modo demonstração (DEMO_MODE=1), dados em memória.
 */

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);
}

/** Valores reais (sem o "— selecione —") de um select. */
async function opcoes(page: Page, campo: string): Promise<string[]> {
  return page
    .locator(`select[name="${campo}"] option`)
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
}

/** Cadastra a categoria de fornecedor (idempotente por nome). */
async function garantirCategoria(page: Page, nome: string): Promise<void> {
  await page.goto("/cadastros/categorias-fornecedores");
  await page.fill('input[name="name"]', nome);
  await page.getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByRole("cell", { name: nome })).toBeVisible();
}

test("cadastra uma subcategoria a pagar, seleciona no novo título e o título sai gravado com ela", async ({ page }) => {
  await login(page);
  const marca = Date.now();
  const subcategoria = `Energia Teste ${marca}`;

  // 1. Cadastro aparece na tela Cadastros e aceita a inclusão.
  await page.goto("/cadastros");
  await page.getByRole("link", { name: /Subcategoria a PAGAR/ }).click();
  await expect(page).toHaveURL(/\/cadastros\/subcategorias-pagar/, { timeout: 60_000 });
  await page.fill('input[name="name"]', subcategoria);
  await page.getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByRole("cell", { name: subcategoria })).toBeVisible({ timeout: 30_000 });

  // 2. Novo título: a caixa Subcategoria é um select com a subcategoria cadastrada.
  await garantirCategoria(page, "Insumos Gerais");
  await page.goto("/contas-a-pagar");
  const subs = await opcoes(page, "subcategory");
  expect(subs).toContain(subcategoria);

  const forn = await page.locator("datalist#fornecedores option").first().getAttribute("value");
  expect(forn, "datalist de fornecedores sem opções").toBeTruthy();
  await page.fill('input[name="supplierName"]', forn!);
  const descricao = `E2E subcategoria ${marca}`;
  await page.fill('input[name="description"]', descricao);
  await page.getByPlaceholder("1.234,56").pressSequentially("12345");
  await page.fill('input[name="dueDate"]', "2026-12-20");
  for (const campo of ["supplierCategory", "costClassification", "costCenterId"]) {
    const valores = await opcoes(page, campo);
    expect(valores.length, `select ${campo} sem opções`).toBeGreaterThan(0);
    await page.locator(`select[name="${campo}"]`).selectOption(valores[0]);
  }
  await page.selectOption('select[name="subcategory"]', subcategoria);
  await page.getByRole("button", { name: "Criar título" }).click();
  await page.waitForURL(/[?&](ok|erro)=/, { timeout: 60_000 });
  expect(page.url(), "a criação do título voltou com erro").not.toMatch(/[?&]erro=/);

  // 3. O título gravado carrega a subcategoria escolhida.
  const r = await page.request.get("/api/v1/payables?limit=200");
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { data: { items?: Array<{ description: string; subcategory?: string }> } | Array<{ description: string; subcategory?: string }> };
  const items = Array.isArray(body.data) ? body.data : (body.data.items ?? []);
  const criado = items.find((x) => x.description === descricao);
  expect(criado?.subcategory).toBe(subcategoria);

  // 4. Desativar a subcategoria em uso: some da caixa, o título continua com ela.
  await page.goto("/cadastros/subcategorias-pagar");
  const linha = page.getByRole("row", { name: new RegExp(subcategoria) });
  await linha.getByRole("button", { name: "Excluir" }).click();
  await expect(page.getByText(/está em uso por 1 título\(s\) a pagar/)).toBeVisible();
  await page.getByRole("button", { name: "Confirmar desativação" }).click();
  await expect(page.locator("p.border-emerald-200")).toContainText("desativada");
  await page.goto("/contas-a-pagar");
  expect(await opcoes(page, "subcategory")).not.toContain(subcategoria);
});
