import { expect, test } from "@playwright/test";

/**
 * E2E da telemetria de atividade: o rastreador global captura navegação e
 * cliques, envia em lote para /api/v1/ui-events, requisições autenticadas à
 * API viram eventos de origem backend, e a aba Atividade de /auditoria exibe
 * tudo com filtros.
 */

test("navegação, cliques e requisições aparecem na aba Atividade", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/);

  // Gera atividade de interface: clique em link do menu + navegação SPA.
  // O lote é enviado a cada ~2s para /api/v1/ui-events.
  const flush = page.waitForResponse(
    (r) => r.url().includes("/api/v1/ui-events") && r.status() === 202
  );
  await page.getByRole("link", { name: "Contas a pagar" }).click();
  await page.waitForURL(/contas-a-pagar/);
  await flush;

  // Uma chamada autenticada à API vira evento de origem backend (via withAuth).
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(200);

  // A aba Atividade lista os eventos.
  await page.goto("/auditoria?aba=atividade");
  const tabela = page.locator("table");
  await expect(tabela.getByText("Navegação").first()).toBeVisible();
  await expect(tabela.getByText("Clique").first()).toBeVisible();
  await expect(tabela.getByText("Requisição à API").first()).toBeVisible();
  await expect(tabela.getByText("/api/v1/me").first()).toBeVisible();
  // Usuária logada identificada nos eventos.
  await expect(tabela.getByText("Ana", { exact: false }).first()).toBeVisible();

  // Filtro por origem: só eventos da interface — nenhuma requisição à API.
  await page.selectOption('select[name="origem"]', "frontend");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page.locator("table").getByText("Requisição à API")).toHaveCount(0);
  await expect(page.locator("table").getByText("Navegação").first()).toBeVisible();

  // O próprio envio de telemetria não vira evento "requisicao" (sem retroalimentação).
  await page.goto("/auditoria?aba=atividade&q=ui-events");
  await expect(page.getByText(/Nenhum evento corresponde/)).toBeVisible();
});
