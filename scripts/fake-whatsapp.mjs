// Fausse page WhatsApp (§39) : sert la fixture de test, puis lance l'application
// dessus avec un dossier de données séparé. Pour essayer l'interface sans compte.
//
//   node scripts/fake-whatsapp.mjs            → démo (npm run demo)
//   import { startFakeWhatsApp } from …       → serveur seul (tests e2e)

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = path.join(root, "tests", "fixtures", "fake-whatsapp", "index.html");

export function startFakeWhatsApp() {
  const html = fs.readFileSync(page);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startFakeWhatsApp();
  const userData = path.join(os.homedir(), ".config", "mcdesk-demo");
  console.log(`Fausse page : ${url}\nDonnées de démo : ${userData}`);
  const electron = (await import("electron")).default;
  const child = spawn(electron, [root, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, WHATHUSH_TARGET_URL: url, WHATHUSH_USER_DATA: userData }
  });
  child.on("exit", (code) => {
    close();
    process.exit(code ?? 0);
  });
}
