// Tests « natifs » : l'application tourne sans Playwright, un script injecté
// mesure et imprime un résultat que ce lanceur vérifie.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { startFakeWhatsApp } from "../../scripts/fake-whatsapp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

async function run(script) {
  const fake = await startFakeWhatsApp();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "whathush-native-"));
  const child = spawn(electron, [root, "--ozone-platform=headless", "--ozone-override-screen-size=1440,920"], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${path.join(here, script)}`,
      WHATHUSH_TEST: "1",
      WHATHUSH_TARGET_URL: fake.url,
      WHATHUSH_USER_DATA: userData,
      WHATHUSH_TRAY: "0"
    }
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  fake.close();
  fs.rmSync(userData, { recursive: true, force: true });
  const line = output.split("\n").find((candidate) => candidate.startsWith("RESULT "));
  if (!line) throw new Error(`pas de résultat pour ${script}\n${output}`);
  return JSON.parse(line.slice("RESULT ".length));
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const visibility = await run("visibility-check.cjs");
check("compte affiché A : page visible, B caché : hidden", visibility.afterA.a === "visible" && visibility.afterA.b === "hidden", visibility.afterA);
check("après bascule : A hidden, B visible", visibility.afterB.a === "hidden" && visibility.afterB.b === "visible", visibility.afterB);
check("pendant une modale : toutes les pages hidden", visibility.duringModal.a === "hidden" && visibility.duringModal.b === "hidden", visibility.duringModal);

for (const { name, ok, detail } of checks) console.log(`${ok ? "✔" : "✘"} ${name}  ${JSON.stringify(detail)}`);
process.exit(checks.every((entry) => entry.ok) ? 0 : 1);
