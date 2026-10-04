import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  globalTeardown: "./tests/e2e/global-teardown.ts"
});
