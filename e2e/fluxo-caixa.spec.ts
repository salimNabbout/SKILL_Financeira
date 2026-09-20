import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildXlsxWorkbook, excelDateSerial } from "../src/lib/exporters/xlsx";
import { readXlsx } from "../src/lib/importers/xlsx-reader";

/**
 * Disciplina Fluxo de Caixa (CETEM) em modo demo: as cinco telas respondem,
 * parâmetros são gravados, a fila "A classificar" classifica em um clique,
 * as grades refletem o de-para, a planilha .xlsx é exportada (7 abas) e a
 * importação da aba Lançamentos é tudo-ou-nada e não duplica o que já existe.
 */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Planilha só com a aba Lançamentos e uma linha nova (como o usuário montaria). */
function novaLinhaXlsx(descricao: string): Buffer {
  const headers = ["Data", "Tipo", "Categoria", "Descrição", "Centro de Custo", "Status", "Valor"];
  const cells: Record<string, { v: string | number }> = {};
  headers.forEach((h, i) => (cells[`${String.fromCharCode(65 + i)}1`] = { v: h }));
  const row = [excelDateSerial("2026-09-03"), "Entrada", "Prestação de Serviços", descricao, "", "Realizado", 1234.56];
  row.forEach((v, i) => {
    if (v !== "") cells[`${String.fromCharCode(65 + i)}2`] = { v };
  });
  return Buffer.from(buildXlsxWorkbook({ sheets: [{ name: "Lançamentos", cells }] }));
}

/** Aba da disciplina (o menu lateral também tem "Dashboard"; a aba fica na nav própria). */
function tab(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Telas do Fluxo de Caixa" }).getByRole("link", { name, exact: true });
}

/**
 * Substitui o valor de um MoneyInput. A máscara remonta o valor a partir dos
 * dígitos e, ao focar, leva o cursor para o fim — por isso `fill()` ANEXA ao
 * valor padrão em vez de substituir. Como um usuário: seleciona tudo e digita.
 */
async function typeMoney(input: Locator, digits: string) {
  // Enquanto o React não hidratou o campo, a máscara não formata: repete até formatar.
  await expect
    .poll(
      async () => {
        await input.click();
        await input.press("Control+a");
        await input.pressSequentially(digits);
        return input.inputValue();
      },
      { timeout: 20_000 }
    )
    .toMatch(/,\d{2}$/);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', "ana@cafeaurora.com.br");
  await page.fill('input[name="password"]', "demo1234");
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/$/);
}

test("telas, parâmetros, fila de classificação e grades do Fluxo de Caixa", async ({ page }) => {
  await login(page);

  // Menu e dashboard sem parâmetros gravados
  await page.getByRole("link", { name: "Fluxo de Caixa CETEM" }).click();
  await expect(page).toHaveURL(/\/fluxo-caixa(\?.*)?$/);
  await expect(page.getByRole("heading", { level: 1, name: "Fluxo de Caixa CETEM" })).toBeVisible();
  await expect(page.getByText(/Parâmetros do exercício não configurados/)).toBeVisible();
  await expect(page.getByText(/Dados calculados em/)).toBeVisible();

  // Parâmetros: grava saldo inicial, reserva e cenários
  await tab(page, "Parâmetros").click();
  await expect(page.getByRole("heading", { level: 1, name: "Parâmetros do Fluxo de Caixa" })).toBeVisible();
  const saldo = page.locator("#openingBalance");
  await typeMoney(saldo, "8500000");
  await expect(saldo).toHaveValue("85.000,00");
  const reserva = page.locator("#minimumReserve");
  await typeMoney(reserva, "6000000");
  await expect(reserva).toHaveValue("60.000,00");
  await page.fill('input[name="pessimista_receita"]', "-20,0");
  await page.getByRole("button", { name: "Gravar parâmetros e cenários" }).click();
  await expect(page.getByText(/Parâmetros e cenários gravados/)).toBeVisible();
  await expect(page.getByText(/Gravado \(v1\)/)).toBeVisible();
  await expect(page.locator("#openingBalance")).toHaveValue("85.000,00");
  await expect(page.locator("#minimumReserve")).toHaveValue("60.000,00");
  await expect(page.locator('input[name="pessimista_receita"]')).toHaveValue("-20,0");

  // Lançamentos: fila a_classificar com chaves do seed e classificação em um clique
  await tab(page, "Lançamentos").click();
  const fila = page.getByTestId("fila-classificar");
  await expect(fila).toBeVisible();
  const primeira = fila.locator("tbody tr").first();
  const chave = (await primeira.locator("td").first().innerText()).trim();
  await primeira.locator('select[name="categoryId"]').selectOption({ index: 1 });
  await primeira.getByRole("button", { name: "Classificar" }).click();
  await expect(page.getByText(new RegExp(`De-para criado: "${chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`))).toBeVisible();
  await expect(page.getByTestId("fila-classificar").locator("tbody tr").filter({ hasText: chave })).toHaveCount(0);

  // Grade de lançamentos com origem e totais
  await expect(page.getByText(/lançamento\(s\) · entradas/)).toBeVisible();
  await expect(page.locator("table").last().locator("tbody tr").first()).toBeVisible();

  // Fluxo Mensal: grade com saldo encadeado partindo de 85.000,00
  await tab(page, "Fluxo Mensal").click();
  await expect(page.getByTestId("fluxo-mensal")).toBeVisible();
  await expect(page.getByText("Total de Entradas")).toBeVisible();
  await expect(page.getByText("Saldo Final", { exact: true })).toBeVisible();
  // Saldo Inicial de janeiro = parâmetro gravado; sem movimento em janeiro, Saldo Final = 85.000,00.
  await expect(page.getByTestId("saldo-final-1")).toHaveText("85.000,00");

  // Previsto × Realizado
  await tab(page, "Previsto × Realizado").click();
  await expect(page.getByTestId("previsto-realizado")).toBeVisible();
  await expect(page.getByText("Total de Saídas")).toBeVisible();

  // Dashboard configurado: KPIs e cenários
  await tab(page, "Dashboard").click();
  await expect(page.getByTestId("fc-kpis")).toBeVisible();
  await expect(page.getByText(/Saldo em 12 meses — pessimista/)).toBeVisible();
  await expect(page.getByText(/Parâmetros do exercício não configurados/)).toHaveCount(0);
});

test("exporta a planilha (7 abas, fórmulas vivas) e importa a aba Lançamentos sem duplicar nem gravar com erro", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  await page.goto("/fluxo-caixa/lancamentos?ano=2026");
  await expect(page.getByRole("heading", { level: 1, name: "Lançamentos do Fluxo de Caixa" })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("fc-exportar").click()]);
  expect(download.suggestedFilename()).toMatch(/^fluxo-caixa-cetem_\d{4}_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const exportado = readFileSync((await download.path())!);
  expect(exportado.subarray(0, 2).toString("latin1")).toBe("PK");
  const wb = readXlsx(new Uint8Array(exportado));
  expect(wb.sheetNames).toEqual(["Instruções", "Parâmetros", "Lançamentos", "Fluxo Mensal", "Previsto x Realizado", "Projeção", "Dashboard"]);
  expect(wb.readSheet("Lançamentos")!.maxRow).toBeGreaterThan(2);
  for (const name of ["Dashboard", "Fluxo Mensal", "Previsto × Realizado", "Parâmetros", "Lançamentos"]) {
    await tab(page, name).click();
    await expect(page.getByTestId("fc-exportar")).toBeVisible();
  }

  // Importação 1: reimportar a própria exportação não cria nada (totais preservados)
  await page.getByRole("link", { name: "Importar planilha" }).click();
  // Em dev, a primeira visita compila a rota: a navegação pode levar mais que os 5 s padrão.
  await expect(page).toHaveURL(/\/fluxo-caixa\/importar/, { timeout: 60_000 });
  await page.setInputFiles('input[name="arquivo"]', { name: download.suggestedFilename(), mimeType: XLSX_MIME, buffer: exportado });
  await page.getByRole("button", { name: "Analisar planilha" }).click();
  // A análise é uma server action: no runner do CI, em modo dev, pode passar dos 5 s padrão.
  await expect(page.getByTestId("fc-import-relatorio")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Nenhuma linha nova para importar")).toBeVisible();
  await expect(page.getByTestId("fc-import-ignoradas")).toBeVisible();

  // Importação 2: planilha com uma linha nova → analisar → confirmar → ajuste manual criado
  await page.setInputFiles('input[name="arquivo"]', { name: "novos.xlsx", mimeType: XLSX_MIME, buffer: novaLinhaXlsx("Contrato E2E importado") });
  await page.getByRole("button", { name: "Analisar planilha" }).click();
  await expect(page.getByTestId("fc-import-validas")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("fc-import-validas")).toContainText("Contrato E2E importado");
  await page.getByRole("button", { name: /Confirmar importação \(1 linha\(s\)\)/ }).click();
  await expect(page).toHaveURL(/\/fluxo-caixa\/lancamentos/, { timeout: 60_000 });
  await expect(page.getByText(/1 ajuste\(s\) manual\(is\) criado\(s\)/)).toBeVisible({ timeout: 30_000 });
  await page.goto("/fluxo-caixa/lancamentos?ano=2026&origem=ajuste_manual");
  await expect(page.getByText("Contrato E2E importado")).toBeVisible();

  // Importação 3: linha inválida rejeita o arquivo inteiro (nada gravado)
  await page.goto("/fluxo-caixa/importar?ano=2026");
  const invalida = buildXlsxWorkbook({
    sheets: [{ name: "Lançamentos", cells: { A1: { v: "Data" }, B1: { v: "Tipo" }, C1: { v: "Categoria" }, D1: { v: "Descrição" }, F1: { v: "Status" }, G1: { v: "Valor" }, A2: { v: "31/02/2026" }, B2: { v: "Entrada" }, C2: { v: "Aluguel" }, D2: { v: "Errada" }, F2: { v: "Realizado" }, G2: { v: -5 } } }],
  });
  await page.setInputFiles('input[name="arquivo"]', { name: "erro.xlsx", mimeType: XLSX_MIME, buffer: Buffer.from(invalida) });
  await page.getByRole("button", { name: "Analisar planilha" }).click();
  await expect(page.getByTestId("fc-import-erros")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Arquivo rejeitado/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirmar importação/ })).toHaveCount(0);
});
