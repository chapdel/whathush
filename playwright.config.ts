import { defineConfig } from "@playwright/test";

// Identifiant de ce lancement : le nettoyage final ne touche qu'à ses propres dossiers.
process.env.WHATHUSH_E2E_RUN ??= `${process.pid}-${Date.now()}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  globalTeardown: "./tests/e2e/global-teardown.ts"
});
