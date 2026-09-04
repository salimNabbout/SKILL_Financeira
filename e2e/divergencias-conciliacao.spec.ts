import { expect, test } from "@playwright/test";

/**
 * E2E da seção "Divergências do período" na tela de Conciliação.
 *
 * O que se prova aqui é que a seção renderiza com os quatro blocos e que o
 * estado vazio nomeia o mês e a cobertura do extrato — não os números, que são
 * dos testes de unidade da skill.
 */

test("a seção de divergências renderiza com os quatro totais e a navegação de mês", async ({
  page,
}) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);

  await page.goto("/conciliacao");

  const secao = page.locator("section", { hasText: "Divergências do período" }).first();
  await expect(secao).toBeVisible();

  // Os quatro cartões de total.
  for (const rotulo of [
    "Extrato sem explicação",
    "Baixas sem lastro",
    "Valores divergentes",
    "Contas com saldo divergente",
  ]) {
    // O rótulo do cartão é um <p>; o mesmo texto pode reaparecer como <h3> de
    // tabela quando há divergências — daí o filtro por parágrafo.
    await expect(secao.getByRole("paragraph").filter({ hasText: rotulo }).first()).toBeVisible();
  }

  // Exportação aponta para o relatório novo.
  await expect(secao.getByRole("link", { name: "Exportar" })).toHaveAttribute(
    "href",
    /reports\/reconciliation_audit\?period=\d{4}-\d{2}&format=xlsx/
  );
});

test("trocar o mês preserva o filtro de conta da caixa Saldo", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);

  await page.goto("/conciliacao");

  // Escolhe a conta explicitamente: sem parâmetro na URL não há o que preservar
  // (a caixa Saldo cai no default), e o teste passaria sem provar nada.
  const conta = await page.locator('select[name="conta"]').inputValue();
  await page.goto(`/conciliacao?conta=${conta}`);
  const outroMes = page.locator('nav[aria-label="Selecionar mês"] a').first();
  await outroMes.click();

  // O filtro de conta sobrevive à troca de mês (MonthNav com extraQuery).
  await expect(page).toHaveURL(new RegExp(`conta=${conta}`));
  await expect(page.locator("section", { hasText: "Divergências do período" }).first()).toBeVisible();
});

test("sem divergências, o estado vazio nomeia o mês e a cobertura do extrato", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);

  // Um mês bem antigo não tem movimento nenhum no seed demo.
  await page.goto("/conciliacao?dm=2020-01");

  const secao = page.locator("section", { hasText: "Divergências do período" }).first();
  await expect(secao).toContainText("Nenhuma divergência em jan/2020");
  // A cobertura por conta aparece no próprio estado vazio.
  await expect(secao).toContainText(/extrato conferido até|nenhum extrato importado/);
});
