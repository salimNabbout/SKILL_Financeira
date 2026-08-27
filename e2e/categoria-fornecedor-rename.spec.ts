import { expect, test } from "@playwright/test";

/**
 * Renomeação de Categoria de Fornecedores COM CASCATA: fornecedores
 * referenciam a categoria pelo NOME (Supplier.category é string), então
 * renomear sem propagar os deixaria órfãos. Este teste prova que não ficam.
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

test("renomear categoria de fornecedor propaga para quem a usava", async ({ page }) => {
  await login(page);

  const marca = Date.now();
  const nomeOriginal = `Categoria Teste ${marca}`;
  const nomeNovo = `Categoria Teste ${marca} Renomeada`;
  const fornecedor = `FORNECEDOR TESTE ${marca}`;

  // 1. Cadastra a categoria.
  await page.goto("/cadastros/categorias-fornecedores");
  await page.fill('input[name="name"]', nomeOriginal);
  await page.getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByRole("row", { name: new RegExp(nomeOriginal) })).toBeVisible();

  // 2. Cadastra um fornecedor usando essa categoria.
  await page.goto("/cadastros/fornecedores");
  await page.fill('input[name="name"]', fornecedor);
  await page.selectOption('select[name="category"]', { label: nomeOriginal });
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("cell", { name: fornecedor.toUpperCase() })).toBeVisible();

  // 3. Renomeia a categoria.
  await page.goto("/cadastros/categorias-fornecedores");
  const linha = page.getByRole("row", { name: new RegExp(nomeOriginal) });
  await linha.getByRole("button", { name: "Editar" }).click();
  await page.fill(`input[aria-label="Novo nome da categoria ${nomeOriginal}"]`, nomeNovo);
  await page.getByRole("button", { name: "Salvar" }).click();

  // A mensagem de SUCESSO precisa aparecer (e nao "NEXT_REDIRECT"): ok() chama
  // redirect(), que lanca NEXT_REDIRECT; se o ok() ficar dentro do try, o catch
  // o captura e exibe a excecao interna do Next como se fosse erro do usuario.
  await expect(page.locator("p.border-emerald-200")).toContainText(
    "cadastro(s) atualizado(s)"
  );
  await expect(page.getByRole("cell", { name: nomeNovo })).toBeVisible();

  // 4. O fornecedor acompanhou o novo nome — não ficou órfão.
  await page.goto("/cadastros/fornecedores");
  await expect(page.getByRole("row", { name: new RegExp(fornecedor.toUpperCase()) })).toContainText(
    nomeNovo
  );

  // 5. A trilha registra a renomeação com o estado ANTES e DEPOIS (o create
  // grava só o "depois"; sem o "antes" não se sabe de que nome veio).
  await page.goto("/auditoria?entityType=supplier_category");
  const trilha = page.locator("table");
  await expect(trilha).toContainText(nomeOriginal);
  await expect(trilha).toContainText(nomeNovo);
});
