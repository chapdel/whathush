// Point d'entrée du processus principal.

import { app, Menu } from "electron";
import fs from "node:fs";
import path from "node:path";
import { WHATSAPP_ORIGIN, WHATSAPP_URL } from "../shared/constants";
import { APP_ID, DATA_DIR_NAME, PRODUCT_NAME } from "../shared/identity";
import { Application } from "./app";
import { createLogger } from "./log";
import { registerRendererScheme, serveRenderer } from "./renderer-protocol";
import { chromeUserAgent } from "./sessions/session-factory";
import { AppStore } from "./storage/app-store";

const TEST = process.env.WHATHUSH_TEST === "1";
const SELF_TEST = process.argv.includes("--self-test");

// --- Avant ready ------------------------------------------------------------------------

// §38 : dossier de données fixe, indépendant du nom affiché.
const userData = process.env.WHATHUSH_USER_DATA ?? path.join(app.getPath("appData"), DATA_DIR_NAME);
// §27 : les partitions contiennent les sessions WhatsApp, dossier réservé à l'utilisateur.
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.chmodSync(userData, 0o700);
app.setPath("userData", userData);
// Tests : rien n'est écrit hors du dossier temporaire (pas même ~/Téléchargements).
if (TEST) {
  const downloads = path.join(userData, "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  app.setPath("downloads", downloads);
}
app.setName(PRODUCT_NAME);
app.userAgentFallback = chromeUserAgent();
// §25 : saisie IME / emoji sous Wayland natif.
if (process.env.XDG_SESSION_TYPE === "wayland") app.commandLine.appendSwitch("enable-wayland-ime");

const targetUrl = process.env.WHATHUSH_TARGET_URL ?? WHATSAPP_URL;
const whatsappOrigin = process.env.WHATHUSH_TARGET_URL ? new URL(targetUrl).origin : WHATSAPP_ORIGIN;
const distDir = path.join(__dirname, "..");
const devTools = !app.isPackaged || process.env.WHATHUSH_DEVTOOLS === "1";

registerRendererScheme();

// §26 : aucune <webview>, jamais.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

let application: Application | null = null;

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => application?.handleSecondInstance(argv));
  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(async () => {
    // Sans menu : pas de raccourcis parasites (Ctrl+R rechargerait la coque) et pas
    // de plantage en mode headless (constat du Lab).
    Menu.setApplicationMenu(null);
    const log = createLogger(path.join(userData, "logs"), { console: !app.isPackaged && !TEST });
    const store = new AppStore(userData, log);

    serveRenderer(path.join(distDir, "renderer"));
    store.purgePendingPartitions(path.join(userData, "Partitions"));
    application = new Application({
      store,
      log,
      paths: {
        rendererDir: path.join(distDir, "renderer"),
        preloadDir: path.join(distDir, "preload"),
        iconDir: path.join(distDir, "assets"),
        iconPath: path.join(distDir, "assets", "icon.png")
      },
      targetUrl,
      whatsappOrigin,
      test: TEST,
      startHidden: SELF_TEST || process.argv.includes("--hidden") || store.get("preferences").startMinimized,
      devTools,
      initialArgv: process.argv
    });
    if (TEST) (globalThis as { __whathush?: Application }).__whathush = application;
    await application.start();
    log.info("ready", { version: app.getVersion(), electron: process.versions.electron });
    if (SELF_TEST) await selfTest(application, store);
  });
}

/**
 * --self-test : démarre réellement l'application, vérifie que l'interface s'affiche
 * (dans le paquet, avec ses fuses), imprime un bilan JSON et rend la main.
 */
async function selfTest(application: Application, store: AppStore): Promise<void> {
  const contents = application.mainWebContents();
  if (contents.isLoading()) await new Promise<void>((resolve) => contents.once("did-finish-load", () => resolve()));
  let ui: { heading: string | null; sidebar: boolean; url: string } | { error: string };
  try {
    ui = await contents.executeJavaScript(
      `new Promise((resolve) => setTimeout(() => resolve({ heading: document.querySelector("h1")?.textContent ?? null, sidebar: !!document.querySelector(".sidebar"), url: location.href }), 800))`
    );
  } catch (error) {
    ui = { error: String(error) };
  }
  const ok = "sidebar" in ui && ui.sidebar;
  console.log(
    JSON.stringify({
      product: PRODUCT_NAME,
      appId: APP_ID,
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      packaged: app.isPackaged,
      userData,
      accounts: store.get("accounts").accounts.length,
      ui,
      ok
    })
  );
  app.exit(ok ? 0 : 1);
}
