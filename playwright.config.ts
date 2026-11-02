import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // O servidor sobe em modo dev (`npm run dev`): a 1ª chamada de uma server action compila
  // sob demanda e, no CI, passa dos 5 s padrão do `expect` (o teste de upload de OFX falhava
  // com a mensagem de sucesso ainda não renderizada). 20 s dá folga sem esconder falha real.
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://localhost:3100",
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  webServer: {
    command: "cross-env DEMO_MODE=1 PORT=3100 npm run dev",
    url: "http://localhost:3100/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
