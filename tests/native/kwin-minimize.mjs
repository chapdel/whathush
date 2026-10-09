// Test « natif » optionnel (npm run test:kwin) : l'application tourne dans un KWin
// imbriqué sans écran (--virtual), avec son propre bus de session ; rien n'apparaît sur
// le bureau courant. Vérifie qu'une fenêtre réduite par le compositeur masque WhatsApp.
// Page synthétique « compte connecté » : comme web.whatsapp.com (vérifié), elle cesse de
// recevoir des images une fois la fenêtre réduite. (La fausse page des tests e2e, elle,
// continue d'en recevoir sous KWin : elle ne convient pas ici.)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

for (const tool of ["kwin_wayland", "dbus-run-session", "gdbus"]) {
  if (spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0) {
    console.log(`⏭ ${tool} absent : test KWin ignoré`);
    process.exit(0);
  }
}

const page = fs.readFileSync(path.join(root, "tests", "fixtures", "heavy-whatsapp", "index.html"));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fake = { url: `http://127.0.0.1:${server.address().port}/?chats=300`, close: () => server.close() };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "whathush-kwin-"));
const userData = path.join(work, "data");
const session = path.join(work, "session.sh");
fs.writeFileSync(
  session,
  `#!/bin/sh\nexec "${electron}" "${root}" --ozone-platform=wayland --password-store=basic\n`,
  { mode: 0o755 }
);
const child = spawn(
  "dbus-run-session",
  ["--", "kwin_wayland", "--virtual", "--socket", `wayland-whathush-${process.pid}`, "--width", "1440", "--height", "900", "--no-lockscreen", "--exit-with-session", session],
  {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${path.join(here, "kwin-check.cjs")}`,
      WHATHUSH_TEST: "1",
      WHATHUSH_TARGET_URL: fake.url,
      WHATHUSH_USER_DATA: userData,
      WHATHUSH_TRAY: "0",
      LANGUAGE: "fr_FR:fr",
      LANG: "fr_FR.UTF-8",
      LC_ALL: ""
    }
  }
);
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
await new Promise((resolve) => child.on("exit", resolve));
clearTimeout(timer);
fake.close();
fs.rmSync(work, { recursive: true, force: true });

const line = output.split("\n").find((candidate) => candidate.startsWith("RESULT "));
if (!line) {
  console.log(`✘ pas de résultat\n${output.slice(-2000)}`);
  process.exit(1);
}
const result = JSON.parse(line.slice("RESULT ".length));
const checks = [
  ["page visible avant la réduction", result.before === "visible"],
  ["réduite par KWin : WhatsApp masqué (hidden)", result.hidden === true],
  ["restaurée : WhatsApp de nouveau visible", result.visibleAgain === true]
];
for (const [name, ok] of checks) console.log(`${ok ? "✔" : "✘"} ${name}`);
console.log(JSON.stringify(result));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
