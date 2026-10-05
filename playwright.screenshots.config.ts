import { defineConfig } from "@playwright/test";

// Identifiant de ce lancement : le nettoyage final ne touche qu'à ses propres dossiers.
process.env.WHATHUSH_E2E_RUN ??= `${process.pid}-${Date.now()}`;

// Captures AppStream (Flathub, logithèques) : npm run screenshots.
export default defineConfig({
  testDir: "tests/screenshots",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/screenshots",
  globalTeardown: "./tests/e2e/global-teardown.ts"
});
