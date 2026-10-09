// Injecté dans le processus principal (NODE_OPTIONS=--require) par kwin-minimize.mjs,
// dans un KWin imbriqué : la fenêtre est réduite par le compositeur (comme par sa barre de
// titre), ce qu'Electron ne voit pas sous Wayland. La page WhatsApp affichée doit passer
// « hidden » (sonde de présentation de la coque), puis redevenir « visible » à la restauration.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, timeout) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - start > timeout) return false;
    await sleep(250);
  }
}
const gdbus = (args) => new Promise((resolve) => execFile("gdbus", ["call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting", "--method", ...args], () => resolve()));

/** Réduit ou restaure la fenêtre WhatHush par un script KWin. */
async function minimize(minimized) {
  const name = `whathush-${minimized ? "reduire" : "restaurer"}`;
  const file = path.join(os.tmpdir(), `${name}-${process.pid}.js`);
  fs.writeFileSync(file, `for (const w of workspace.windowList()) if ((w.caption || "").includes("WhatHush")) w.minimized = ${minimized};`);
  await gdbus(["org.kde.kwin.Scripting.unloadScript", name]);
  await gdbus(["org.kde.kwin.Scripting.loadScript", file, name]);
  await gdbus(["org.kde.kwin.Scripting.start"]);
}

(async () => {
  let application;
  for (let i = 0; i < 300 && !(application = globalThis.__whathush); i++) await sleep(100);
  await sleep(1000);
  const { BrowserWindow } = require("electron");
  const account = application.accounts.add({ label: "A" });
  const views = application.viewsManager();
  // Page « connectée » : ses conversations s'affichent d'emblée.
  await until(() => application.accounts.runtime(account.id)?.lifecycle === "ready", 30_000);
  const visibility = () => views.webContents(account.id).executeJavaScript("document.visibilityState").catch(() => "error");

  // KWin doit avoir installé la fenêtre (animation d'ouverture terminée) avant de la réduire.
  await sleep(8000);
  const before = await visibility();
  await minimize(true);
  const start = Date.now();
  const hidden = await until(async () => (await visibility()) === "hidden", 40_000);
  const hiddenAfterMs = Date.now() - start;
  const electronSawMinimize = BrowserWindow.getAllWindows()[0]?.isMinimized() ?? null;
  await minimize(false);
  const visibleAgain = await until(async () => (await visibility()) === "visible", 25_000);
  console.log(`RESULT ${JSON.stringify({ before, hidden, hiddenAfterMs, electronSawMinimize, visibleAgain })}`);
  require("electron").app.exit(0);
})().catch((error) => {
  console.log(`RESULT ${JSON.stringify({ error: String(error) })}`);
  require("electron").app.exit(1);
});
