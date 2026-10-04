// Fenêtres de la coque : fenêtre principale (barre latérale + vues WhatsApp) et
// fenêtre des paramètres (§29 : jamais d'overlay React au-dessus des vues).

import { BrowserWindow, nativeTheme, type WebContents } from "electron";
import path from "node:path";
import { t } from "../shared/i18n";
import { PRODUCT_NAME } from "../shared/identity";
import { RENDERER_BASE_URL } from "./renderer-protocol";

export interface WindowPaths {
  rendererDir: string;
  preloadDir: string;
  iconPath: string;
}

/** Couleur avant peinture / reprise du renderer ; mêmes surfaces que les tokens CSS. */
export function windowBackground(settings = false): string {
  return nativeTheme.shouldUseDarkColors ? (settings ? "#1f1f26" : "#18181d") : (settings ? "#ffffff" : "#f7f7f9");
}

function harden(contents: WebContents, rendererUrl: string): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => {
    if (!event.url.startsWith(rendererUrl)) event.preventDefault();
  });
}

/** Interface servie par app:// (voir renderer-protocol.ts). */
export function rendererBaseUrl(): string {
  return RENDERER_BASE_URL;
}

export function createMainWindow(paths: WindowPaths, options: { devTools: boolean; show: boolean }): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: PRODUCT_NAME,
    icon: paths.iconPath,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(paths.preloadDir, "shell.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: options.devTools,
      spellcheck: false
    }
  });
  window.setMenuBarVisibility(false);
  harden(window.webContents, rendererBaseUrl());
  window.once("ready-to-show", () => {
    if (options.show) window.show();
  });
  void window.loadURL(`${rendererBaseUrl()}index.html`);
  return window;
}

export function createSettingsWindow(paths: WindowPaths, parent: BrowserWindow | null, options: { devTools: boolean }): BrowserWindow {
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: t("window.settingsTitle", { product: PRODUCT_NAME }),
    icon: paths.iconPath,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(true),
    ...(parent ? { parent } : {}),
    webPreferences: {
      preload: path.join(paths.preloadDir, "shell.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: options.devTools,
      spellcheck: false
    }
  });
  window.setMenuBarVisibility(false);
  harden(window.webContents, rendererBaseUrl());
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${rendererBaseUrl()}settings.html`);
  return window;
}
