import { defineConfig } from "@playwright/test";

// Opt-in : vraies fenêtres et tray du bureau courant, avec données et WhatsApp de test.
export default defineConfig({
  testDir: "tests/desktop",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/desktop",
  globalTeardown: "./tests/e2e/global-teardown.ts"
});
