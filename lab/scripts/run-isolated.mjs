// Lance le lab en mode « smoke » ou « probe » dans un dossier temporaire, puis
// le supprime après la sortie d'Electron : Chromium réécrit son état sur disque
// pendant l'arrêt, un nettoyage depuis le processus principal serait incomplet.
//
//   node scripts/run-isolated.mjs smoke [arguments Electron…]
//   node scripts/run-isolated.mjs probe [arguments Electron…]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";

const [mode, ...electronArgs] = process.argv.slice(2);
if (mode !== "smoke" && mode !== "probe") {
  console.error("usage : node scripts/run-isolated.mjs <smoke|probe> [arguments Electron…]");
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `feasibility-lab-${mode}-`));
const child = spawn(electronPath, [".", ...electronArgs], {
  stdio: "inherit",
  env: { ...process.env, LAB_MODE: mode, LAB_TEMP_DIR: dir }
});

child.on("exit", (code) => {
  if (code === 0) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`Dossier conservé pour analyse : ${dir}`);
  process.exit(code ?? 1);
});
