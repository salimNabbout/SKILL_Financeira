import { expect, test, type Page } from "@playwright/test";

/**
 * Tema claro/escuro só muda pelo botão "Tema claro / Tema escuro".
 *
 * Nenhuma navegação — recarga, formulário GET, link do menu, server action com
 * redirect — nem a preferência do sistema operacional pode alterar a escolha
 * feita no botão. O tema vem de um cookie que só o botão grava, renderizado
 * pelo servidor em `<html data-theme>`.
 */

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/$/);
}

function tema(page: Page) {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

async function temaNoHtmlDoServidor(page: Page, path: string) {
  // Mesmo jar de cookies da página: é o HTML que o servidor manda, antes de
  // qualquer JavaScript rodar.
  const html = await (await page.request.get(path)).text();
  const m = html.match(/<html[^>]*\bdata-theme="([^"]+)"/);
  return m?.[1] ?? null;
}

test("nenhum outro botão ou navegação muda o tema; só o botão de tema", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await login(page);
  expect(await tema(page)).toBe("light");

  // Só o botão troca.
  await page.getByRole("button", { name: "Tema escuro" }).click();
  await expect(page.getByRole("button", { name: "Tema claro" })).toBeVisible();
  expect(await tema(page)).toBe("dark");
  expect(await temaNoHtmlDoServidor(page, "/")).toBe("dark");

  // Recarga, formulário GET, link do menu e server action com redirect: nada muda.
  await page.reload();
  expect(await tema(page)).toBe("dark");

  await page.goto("/contas-a-pagar?status=pago");
  expect(await tema(page)).toBe("dark");

  await page.getByRole("link", { name: "Cadastros" }).first().click();
  await expect(page).toHaveURL(/\/cadastros$/);
  expect(await tema(page)).toBe("dark");

  await page.goto("/cadastros/categorias-fornecedores");
  await page.fill('input[name="name"]', `Tema E2E ${Date.now()}`);
  await page.getByRole("button", { name: "Adicionar" }).click();
  await expect(page).toHaveURL(/[?&]ok=/);
  expect(await tema(page)).toBe("dark");

  // O sistema operacional mudando de tema não interfere na escolha do botão.
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  expect(await tema(page)).toBe("dark");

  // Volta para claro pelo botão; o sistema em escuro não interfere.
  await page.getByRole("button", { name: "Tema claro" }).click();
  await expect(page.getByRole("button", { name: "Tema escuro" })).toBeVisible();
  expect(await tema(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  expect(await tema(page)).toBe("light");
  await page.goto("/contas-a-pagar?status=pago");
  expect(await tema(page)).toBe("light");
  expect(await temaNoHtmlDoServidor(page, "/contas-a-pagar")).toBe("light");
});
