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

// Photo de profil servie par une seconde origine, comme pps.whatsapp.net (F10).
const AVATAR = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

export async function startFakeWhatsApp() {
  const html = fs.readFileSync(page);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  const avatars = http.createServer((request, response) => {
    if (request.url?.startsWith("/avatar.png")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(AVATAR);
    } else if (request.url?.startsWith("/huge.png")) {
      // Au-delà de 256 Kio : refusée par le processus principal.
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.alloc(300 * 1024, 1));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const port = await listen(server);
  const avatarPort = await listen(avatars);
  return {
    url: `http://127.0.0.1:${port}/`,
    avatarOrigin: `http://127.0.0.1:${avatarPort}`,
    close: () => {
      server.close();
      avatars.close();
    }
  };
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
