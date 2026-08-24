import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // Um worker de propósito: em DEMO_MODE o banco vive na memória do processo do
  // servidor, então TODOS os specs compartilham o mesmo estado. Em paralelo,
  // um spec cria títulos enquanto outro conta linhas na listagem paginada — e a
  // falha aparece longe da causa. Serializar troca ~20s de execução por
  // resultados determinísticos.
  workers: 1,
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
