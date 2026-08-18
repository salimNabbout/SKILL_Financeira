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
  await expect(page.getByText("Café Aurora")).toBeVisible();

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

test("credenciais inválidas são recusadas", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "senha-errada");
  await page.click('button[type="submit"]');
  await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible();
});
