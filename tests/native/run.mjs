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
      WHATHUSH_TRAY: "0",
      // Absence relevée toutes les 300 ms (200 ms pendant l'absence) au lieu de 30 s.
      WHATHUSH_TEST_TIMINGS: JSON.stringify({ presencePollMs: { present: 300, away: 200 } }),
      LANGUAGE: "fr_FR:fr",
      LANG: "fr_FR.UTF-8",
      LC_ALL: ""
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
check("après la modale : B de nouveau visible", visibility.afterModal.b === "visible" && visibility.afterModal.a === "hidden", visibility.afterModal);
check("verrouillé : toutes les pages hidden", visibility.duringLock.a === "hidden" && visibility.duringLock.b === "hidden", visibility.duringLock);
check("déverrouillé : B de nouveau visible", visibility.afterUnlock.b === "visible" && visibility.afterUnlock.a === "hidden", visibility.afterUnlock);
check("fenêtre non présentée (réduite sous Wayland) : toutes les pages hidden", visibility.notPresented.a === "hidden" && visibility.notPresented.b === "hidden", visibility.notPresented);
check("fenêtre de nouveau présentée : B visible", visibility.presentedAgain.b === "visible" && visibility.presentedAgain.a === "hidden", visibility.presentedAgain);
check("absence : toutes les pages hidden", visibility.away.a === "hidden" && visibility.away.b === "hidden", visibility.away);
check("retour : B de nouveau visible", visibility.back.b === "visible" && visibility.back.a === "hidden", visibility.back);
check("Snooze : un son lancé par une page cachée reste coupé", visibility.hiddenPlayback.muted === true && visibility.hiddenPlayback.userStarted === false, visibility.hiddenPlayback);

for (const { name, ok, detail } of checks) console.log(`${ok ? "✔" : "✘"} ${name}  ${JSON.stringify(detail)}`);
process.exit(checks.every((entry) => entry.ok) ? 0 : 1);
