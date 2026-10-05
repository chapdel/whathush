// Intégration bureau Linux : détection du tray, lancement au démarrage,
// gestionnaire de liens whatsapp://, menu contextuel des vues.

import { app, clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "../../shared/i18n";
import { APP_ID, EXECUTABLE_NAME, PRODUCT_NAME } from "../../shared/identity";
import type { Logger } from "../log";

function run(command: string, args: string[], timeoutMs = 3000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });
}

/**
 * GNOME sans l'extension AppIndicator n'a pas de tray. On vérifie la présence
 * d'un StatusNotifierWatcher sur le bus de session.
 */
export async function isTrayAvailable(log: Logger): Promise<boolean> {
  const result = await run("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.DBus",
    "--object-path",
    "/org/freedesktop/DBus",
    "--method",
    "org.freedesktop.DBus.NameHasOwner",
    "org.kde.StatusNotifierWatcher"
  ]);
  if (!result.ok) {
    log.warn("tray-detection-failed");
    return false;
  }
  return result.stdout.includes("true");
}

const isFlatpak = (): boolean => Boolean(process.env.FLATPAK_ID);

function autostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", `${APP_ID}.desktop`);
}

/**
 * Argument de la clé Exec d'un fichier .desktop : toujours entre guillemets, avec
 * \ " ` $ échappés et % doublé (spécification Desktop Entry).
 */
export function desktopExecArg(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (char) => `\\${char}`).replace(/%/g, "%%")}"`;
}

function launchArgs(): string[] {
  // AppImage : le chemin de l'image, pas celui du point de montage temporaire.
  const executable = process.env.APPIMAGE ?? process.execPath;
  return app.isPackaged ? [executable] : [executable, app.getAppPath()];
}

/**
 * app.setLoginItemSettings ne fonctionne pas sous Linux. Hors Flatpak, un
 * fichier .desktop dans ~/.config/autostart ; sous Flatpak, le portail Background.
 */
export async function setLaunchAtLogin(enabled: boolean, log: Logger): Promise<boolean> {
  try {
    return await applyLaunchAtLogin(enabled, log);
  } catch (error) {
    log.error("autostart-failed", { enabled, error: String(error) });
    return false;
  }
}

async function applyLaunchAtLogin(enabled: boolean, log: Logger): Promise<boolean> {
  if (isFlatpak()) {
    // La commande est celle du manifeste Flatpak (`command: whathush`), pas l'identifiant.
    // Le portail répond de façon asynchrone (signal Response) : un refus de
    // l'utilisateur n'est pas détecté ici.
    const reason = t("autostart.reason", { product: PRODUCT_NAME }).replace(/['\\]/g, "");
    const options = `{'reason': <'${reason}'>, 'autostart': <${enabled}>, 'commandline': <['${EXECUTABLE_NAME}', '--hidden']>, 'dbus-activatable': <false>}`;
    const result = await run("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      "/org/freedesktop/portal/desktop",
      "--method",
      "org.freedesktop.portal.Background.RequestBackground",
      "",
      options
    ]);
    log.info("autostart-portal", { enabled, ok: result.ok });
    return result.ok;
  }
  const file = autostartFile();
  if (!enabled) {
    fs.rmSync(file, { force: true });
    log.info("autostart", { enabled });
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${PRODUCT_NAME}`,
    `Exec=${[...launchArgs(), "--hidden"].map(desktopExecArg).join(" ")}`,
    `Icon=${APP_ID}`,
    "X-GNOME-Autostart-enabled=true",
    "NoDisplay=false",
    ""
  ].join("\n");
  fs.writeFileSync(file, content, { mode: 0o644 });
  log.info("autostart", { enabled });
  return true;
}

/**
 * Gestionnaire des liens whatsapp://, en option (désactivé par défaut).
 * Les entrées de bureau des paquets déclarent le type ; l'option en fait le choix
 * par défaut. L'AppImage n'installe aucune entrée : on en écrit une pour l'utilisateur.
 */
export async function setWhatsappLinkHandler(enabled: boolean, log: Logger): Promise<boolean> {
  try {
    return await applyWhatsappLinkHandler(enabled, log);
  } catch (error) {
    log.error("link-handler-failed", { enabled, error: String(error) });
    return false;
  }
}

async function applyWhatsappLinkHandler(enabled: boolean, log: Logger): Promise<boolean> {
  if (!app.isPackaged || isFlatpak()) return true;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const userEntry = path.join(dataHome, "applications", `${APP_ID}.desktop`);
  if (process.env.APPIMAGE) {
    if (enabled) {
      fs.mkdirSync(path.dirname(userEntry), { recursive: true });
      fs.writeFileSync(
        userEntry,
        [
          "[Desktop Entry]",
          "Type=Application",
          `Name=${PRODUCT_NAME}`,
          `Exec=${[...launchArgs(), "%U"].map((part) => (part === "%U" ? part : desktopExecArg(part))).join(" ")}`,
          `Icon=${APP_ID}`,
          "NoDisplay=true",
          "MimeType=x-scheme-handler/whatsapp;",
          ""
        ].join("\n"),
        { mode: 0o644 }
      );
    } else {
      fs.rmSync(userEntry, { force: true });
    }
  }
  if (enabled) {
    const result = await run("xdg-mime", ["default", `${APP_ID}.desktop`, "x-scheme-handler/whatsapp"]);
    log.info("link-handler", { enabled, ok: result.ok });
    return result.ok;
  }
  log.info("link-handler", { enabled, note: "le bureau choisit de nouveau le gestionnaire" });
  return true;
}

/** Ce dont le menu contextuel a besoin d'une page (une WebContents, ou un double en test). */
export interface ContextMenuTarget {
  replaceMisspelling(word: string): void;
  addWordToDictionary(word: string): void;
  pasteAndMatchStyle(): void;
  copyImageAt(x: number, y: number): void;
  downloadURL(url: string): void;
  inspectElement(x: number, y: number): void;
  copyText(text: string): void;
}

type ContextParams = Pick<ContextMenuParams, "misspelledWord" | "dictionarySuggestions" | "isEditable" | "editFlags" | "selectionText" | "mediaType" | "srcURL" | "linkURL" | "x" | "y">;

/** Modèle du menu contextuel d'une vue WhatsApp. */
export function contextMenuTemplate(params: ContextParams, target: ContextMenuTarget, options: { devTools: boolean; openLink(url: string): void }): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => target.replaceMisspelling(suggestion) });
    }
    items.push({ label: t("context.addToDictionary"), click: () => target.addWordToDictionary(params.misspelledWord) });
    items.push({ type: "separator" });
  }

  if (params.isEditable) {
    items.push(
      { role: "undo", label: t("context.undo"), enabled: params.editFlags.canUndo },
      { role: "redo", label: t("context.redo"), enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", label: t("context.cut"), enabled: params.editFlags.canCut },
      { role: "copy", label: t("context.copy"), enabled: params.editFlags.canCopy },
      { role: "paste", label: t("context.paste"), enabled: params.editFlags.canPaste },
      // Sans la mise en forme de la source (Ctrl+Maj+V, géré par Chromium).
      { label: t("context.pastePlain"), accelerator: "CommandOrControl+Shift+V", enabled: params.editFlags.canPaste, click: () => target.pasteAndMatchStyle() },
      { role: "selectAll", label: t("context.selectAll") }
    );
  } else if (params.selectionText) {
    items.push({ role: "copy", label: t("context.copy") });
  }

  if (params.mediaType === "image" && params.srcURL) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push(
      { label: t("context.copyImage"), click: () => target.copyImageAt(params.x, params.y) },
      { label: t("context.saveImage"), click: () => target.downloadURL(params.srcURL) }
    );
  }

  if (params.linkURL) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push(
      { label: t("context.copyLink"), click: () => target.copyText(params.linkURL) },
      { label: t("context.openLink"), click: () => options.openLink(params.linkURL) }
    );
  }

  if (options.devTools) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ label: t("context.inspect"), click: () => target.inspectElement(params.x, params.y) });
  }
  return items;
}

/** Menu contextuel des vues WhatsApp (Electron n'en fournit aucun). */
export function attachContextMenu(webContents: WebContents, options: { devTools: boolean; openLink(url: string): void }): void {
  const target: ContextMenuTarget = {
    replaceMisspelling: (word) => webContents.replaceMisspelling(word),
    addWordToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
    pasteAndMatchStyle: () => webContents.pasteAndMatchStyle(),
    copyImageAt: (x, y) => webContents.copyImageAt(x, y),
    downloadURL: (url) => webContents.downloadURL(url),
    inspectElement: (x, y) => webContents.inspectElement(x, y),
    copyText: (text) => void clipboard.writeText(text).catch(() => undefined)
  };
  webContents.on("context-menu", (_event, params: ContextMenuParams) => {
    const items = contextMenuTemplate(params, target, options);
    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}
