// Mises à jour de l'AppImage (§42). Les autres formats passent par leur dépôt
// (Flathub, APT, RPM, AUR). Inactif tant qu'aucun canal de publication n'est
// configuré : electron-builder n'écrit app-update.yml que dans ce cas.

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./log";

export async function checkAppImageUpdates(log: Logger, notify: (message: string) => void): Promise<void> {
  const config = path.join(process.resourcesPath, "app-update.yml");
  if (!fs.existsSync(config)) {
    log.info("updates-disabled", { reason: "aucun canal de publication configuré" });
    return;
  }
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    log.info("update-downloaded", { version: info.version });
    notify(`La version ${info.version} sera installée à la prochaine fermeture de l’application.`);
  });
  autoUpdater.on("error", (error) => log.warn("update-error", { message: error.message }));
  await autoUpdater.checkForUpdates();
}
