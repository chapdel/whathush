// Sonde du banc de mesure, chargée dans le processus principal (NODE_OPTIONS=--require) :
// correspondance processus → rôle (compte, coque), fenêtre masquée à la demande, et à la
// fin, tas JS et taille du DOM de chaque page.

const fs = require("node:fs");

const out = process.env.BENCH_PROBE_OUT;
const hideAt = Number(process.env.BENCH_HIDE_AT || 0);
/** Absence simulée (mode test) et fenêtre non présentée (ce que la sonde de la coque signale). */
const awayAt = Number(process.env.BENCH_AWAY_AT || 0);
const unpresentAt = Number(process.env.BENCH_UNPRESENT_AT || 0);
const finalAt = Number(process.env.BENCH_FINAL_AT || 0);

// require("electron") n'est résolu qu'une fois Electron initialisé.
setTimeout(() => {
  const { app, webContents, BrowserWindow } = require("electron");

  const pages = () =>
    webContents.getAllWebContents().map((wc) => {
      let pid = null;
      try {
        pid = wc.getOSProcessId();
      } catch {
        // page en cours de création
      }
      const account = /wa-([0-9a-f-]{36})/.exec(wc.session.storagePath || "")?.[1] ?? null;
      return { url: wc.getURL(), pid, account };
    });

  const write = (extra = {}) => {
    if (out) fs.writeFileSync(out, JSON.stringify({ pages: pages(), ...extra }));
  };

  app.whenReady().then(() => {
    const timer = setInterval(() => write(), 10_000);
    setTimeout(() => write(), 3000);
    if (hideAt) setTimeout(() => BrowserWindow.getAllWindows().forEach((window) => window.hide()), hideAt * 1000);
    if (awayAt) setTimeout(() => globalThis.__whathush?.probe && (globalThis.__whathush.probe.idleSeconds = 24 * 3600), awayAt * 1000);
    if (unpresentAt) {
      setTimeout(() => {
        const shell = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith("app://renderer/index.html"));
        shell?.executeJavaScript('window.whathush.command({ type: "presentation", presented: false })').catch(() => undefined);
      }, unpresentAt * 1000);
    }
    if (finalAt) {
      setTimeout(async () => {
        const detail = [];
        for (const wc of webContents.getAllWebContents()) {
          try {
            detail.push({
              url: wc.getURL().slice(0, 60),
              ...(await wc.executeJavaScript("({ heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, nodes: document.getElementsByTagName('*').length, visibility: document.visibilityState })"))
            });
          } catch (error) {
            detail.push({ url: wc.getURL().slice(0, 60), error: String(error) });
          }
        }
        clearInterval(timer);
        write({ final: true, detail });
      }, finalAt * 1000);
    }
  });
}, 0);
