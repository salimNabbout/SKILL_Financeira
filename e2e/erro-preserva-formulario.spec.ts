import { expect, test } from "@playwright/test";

/**
 * Erro de validação não pode apagar o formulário.
 *
 * A regra (vencimento anterior à emissão) vive na skill contas_a_pagar; aqui
 * verificamos o comportamento da tela: a mensagem aparece E o preenchimento
 * continua no lugar, para o usuário corrigir um campo em vez de redigitar tudo.
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

async function opcoes(page: Page, campo: string): Promise<string[]> {
  return page
    .locator(`select[name="${campo}"] option`)
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
}

async function garantirCategoria(page: Page, nome: string): Promise<void> {
  await page.goto("/cadastros/categorias-fornecedores");
  await page.fill('input[name="name"]', nome);
  await page.getByRole("button", { name: "Adicionar" }).click();
  await expect(page.getByRole("cell", { name: nome })).toBeVisible();
}

test("vencimento antes da emissão: mostra o erro e preserva o preenchimento", async ({ page }) => {
  await login(page);
  await garantirCategoria(page, "Insumos Gerais");

  await page.goto("/contas-a-pagar");
  if ((await opcoes(page, "supplierCategory")).length === 0) {
    await garantirCategoria(page, "Insumos Gerais");
    await page.goto("/contas-a-pagar");
  }

  // O formulário só existe com fornecedor E categoria cadastrados; espera-o
  // aparecer antes de preencher (outros specs compartilham o servidor demo).
  await expect(page.locator('input[name="description"]')).toBeVisible();

  const descricao = `E2E datas ${Date.now()}`;
  // Datas únicas por execução: sem documento, a chave natural do título inclui
  // fornecedor + emissão + vencimento, e datas fixas colidiriam com outras
  // execuções no mesmo servidor demo (a criação viraria replay idempotente).
  const dia = String((Date.now() % 27) + 1).padStart(2, "0");
  const emissao = `2026-06-${dia}`;
  const vencimentoInvalido = "2026-05-01";
  const vencimentoValido = `2026-07-${dia}`;

  await page.fill('input[name="description"]', descricao);
  await page.getByPlaceholder("1.234,56").pressSequentially("123456");
  await page.fill('input[name="issueDate"]', emissao);
  // Vencimento ANTERIOR à emissão: a skill recusa.
  await page.fill('input[name="dueDate"]', vencimentoInvalido);
  await page.fill('input[name="installmentCount"]', "3");

  const escolhidos: Record<string, string> = {};
  for (const campo of ["supplierId", "supplierCategory", "costClassification"]) {
    const valores = await opcoes(page, campo);
    expect(valores.length, `select ${campo} sem opções`).toBeGreaterThan(0);
    escolhidos[campo] = valores[0];
    await page.locator(`select[name="${campo}"]`).selectOption(valores[0]);
  }

  await page.getByRole("button", { name: "Criar título" }).click();

  // 1.1 — a mensagem é exatamente a definida na skill.
  await expect(page.locator("p.border-red-200")).toContainText("Verificar a Data da Emissão");

  // 1.2 — cada campo voltou preenchido.
  await expect(page.locator('input[name="description"]')).toHaveValue(descricao);
  await expect(page.getByPlaceholder("1.234,56")).toHaveValue("1.234,56");
  await expect(page.locator('input[name="issueDate"]')).toHaveValue(emissao);
  await expect(page.locator('input[name="dueDate"]')).toHaveValue(vencimentoInvalido);
  await expect(page.locator('input[name="installmentCount"]')).toHaveValue("3");
  for (const [campo, valor] of Object.entries(escolhidos)) {
    await expect(page.locator(`select[name="${campo}"]`)).toHaveValue(valor);
  }

  // 1.3 — o card fica destacado, para não parecer que o preenchimento sumiu.
  await expect(page.locator(".ring-2")).toBeVisible();

  // Corrigindo só a data que estava errada, o título é criado.
  await page.fill('input[name="dueDate"]', vencimentoValido);
  await page.getByRole("button", { name: "Criar título" }).click();
  await expect(page.locator("p.border-emerald-200")).toContainText("Título criado");
});
