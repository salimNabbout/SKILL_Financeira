import { expect, test } from "@playwright/test";

/**
 * Máscara monetária do MoneyInput no navegador: digitação estilo caixa
 * eletrônico, valor pequeno, backspace, colagem — e o valor que efetivamente
 * chega ao servidor e volta formatado na listagem.
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

/** Valores reais (sem o "— selecione —") de um select. */
async function opcoes(page: Page, campo: string): Promise<string[]> {
  return page
    .locator(`select[name="${campo}"] option`)
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
}

/** Cadastra a categoria (idempotente por nome). */
async function garantirCategoria(page: Page, nome: string): Promise<void> {
  await page.goto("/cadastros/categorias-fornecedores");
  await page.fill('input[name="name"]', nome);
  await page.getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByRole("cell", { name: nome })).toBeVisible();
}

test("máscara monetária: digitação, valor pequeno, colagem e gravação", async ({ page }) => {
  await login(page);

  // O seed demo nao traz Categoria de Fornecedores e o campo e obrigatorio no
  // formulario de novo titulo — cadastra uma para o fluxo poder ser concluido.
  // O cadastro e idempotente por nome, entao repetir e seguro; a repeticao
  // cobre a corrida com os demais specs, que compartilham o servidor demo.
  await garantirCategoria(page, "Insumos Gerais");

  await page.goto("/contas-a-pagar");
  if ((await opcoes(page, "supplierCategory")).length === 0) {
    await garantirCategoria(page, "Insumos Gerais");
    await page.goto("/contas-a-pagar");
  }

  const valor = page.getByPlaceholder("1.234,56");

  // Estilo caixa eletrônico: os dígitos entram pela direita.
  await valor.pressSequentially("150000000");
  await expect(valor).toHaveValue("1.500.000,00");

  // Valor pequeno: 5 vira cinco centavos, não cinco reais.
  await valor.fill("");
  await valor.pressSequentially("5");
  await expect(valor).toHaveValue("0,05");

  // Backspace remove o último dígito e reformata.
  await valor.press("Backspace");
  await expect(valor).toHaveValue("");

  // Colar valor já formatado é normalizado para o mesmo texto.
  await valor.fill("1.234,56");
  await expect(valor).toHaveValue("1.234,56");

  // Letras e separadores extras não passam.
  await valor.fill("abc1x2,3,4");
  await expect(valor).toHaveValue("12,34");

  // Agora o caminho completo: 1.500.000,00 gravado e exibido na listagem.
  await valor.fill("");
  await valor.pressSequentially("150000000");
  await expect(valor).toHaveValue("1.500.000,00");

  const descricao = `E2E máscara ${Date.now()}`;
  await page.fill('input[name="description"]', descricao);
  await page.fill('input[name="dueDate"]', "2026-12-20");

  // Selects obrigatórios: primeira opção real de cada um.
  for (const campo of ["supplierId", "supplierCategory", "costClassification"]) {
    const valores = await opcoes(page, campo);
    expect(valores.length, `select ${campo} sem opções`).toBeGreaterThan(0);
    await page.locator(`select[name="${campo}"]`).selectOption(valores[0]);
  }

  await page.getByRole("button", { name: "Criar título" }).click();

  // O título gravado aparece com o valor formatado pelo servidor (formatBRL).
  await expect(page.getByText(descricao)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(descricao) })).toContainText(
    "R$ 1.500.000,00"
  );
});
