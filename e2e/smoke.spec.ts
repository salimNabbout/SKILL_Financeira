import { expect, test } from "@playwright/test";

/**
 * Smoke E2E em modo demonstração (dados fictícios em memória).
 * O webServer do playwright.config.ts sobe o app com DEMO_MODE=1 na porta 3100.
 */

test("login demo e navegação pelas telas principais", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Modo demonstração")).toBeVisible();

  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');

  // Dashboard autenticado
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Café Aurora").first()).toBeVisible();

  // Telas principais respondem sem erro
  for (const path of [
    "/contas-a-pagar",
    "/contas-a-receber",
    "/fluxo-de-caixa",
    "/conciliacao",
    "/aprovacoes",
    "/alertas",
    "/auditoria",
  ]) {
    const response = await page.goto(path);
    expect(response?.status(), `rota ${path}`).toBeLessThan(500);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("upload real de arquivo OFX na conciliação (com reimportação idempotente)", async ({
  page,
}) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);

  // 1ª importação: 2 transações novas via upload de arquivo (formato automático)
  await page.goto("/conciliacao");
  await page.selectOption('select[name="bankAccountId"]', "ba_itau");
  await page.setInputFiles('input[name="arquivo"]', "e2e/fixtures/extrato-e2e.ofx");
  await page.getByRole("button", { name: "Importar e conciliar" }).click();
  await expect(page.getByText(/Importação concluída: 2 nova\(s\)/)).toBeVisible();

  // Reimportar o MESMO arquivo aciona a idempotência de requisição do
  // orquestrador: a resposta vem do cache, nada é reprocessado.
  await page.selectOption('select[name="bankAccountId"]', "ba_itau");
  await page.setInputFiles('input[name="arquivo"]', "e2e/fixtures/extrato-e2e.ofx");
  await page.getByRole("button", { name: "Importar e conciliar" }).click();
  await expect(page.getByText(/requisição repetida — nada foi reprocessado/)).toBeVisible();

  // Arquivo PARCIALMENTE sobreposto (conteúdo diferente → novo fluxo): o dedupe
  // por FITID ignora a transação repetida e importa só a nova.
  await page.selectOption('select[name="bankAccountId"]', "ba_itau");
  await page.setInputFiles('input[name="arquivo"]', "e2e/fixtures/extrato-e2e-parcial.ofx");
  await page.getByRole("button", { name: "Importar e conciliar" }).click();
  await expect(
    page.getByText(/Importação concluída: 1 nova\(s\), 1 duplicada\(s\)/)
  ).toBeVisible();
});

test("credenciais inválidas são recusadas", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "senha-errada");
  await page.click('button[type="submit"]');
  await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible();
});
